/* ─────────────────────────── Chat de DX Grand Prix ───────────────────────────
   Comptes (ID à 8 chiffres + code secret ; le nom affiché est celui du
   joueur dans le jeu, « Joueur 12 » s'il n'en a pas), amis, présence en ligne, messages privés
   (gardés pour ceux qui ne sont pas là), groupes de discussion, invitations
   dans un groupe multijoueur.

   Sécurité : on ne parle qu'à ses amis (demande à accepter), on peut bloquer,
   les insultes sont masquées ainsi que les numéros, adresses mail et liens.

   Stockage : tout est gardé en mémoire ; s'il y a SUPABASE_URL et
   SUPABASE_SECRET (variables d'environnement de Render), chaque changement est
   aussi écrit dans Supabase et relu au démarrage — sinon dans chat.json (perdu
   quand Render redémarre). La clé secrète ne quitte jamais le serveur.      */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SUPA_URL = (process.env.SUPABASE_URL || "").replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "");
const SUPA_CLE = process.env.SUPABASE_SECRET || process.env.SUPABASE_SERVICE_KEY || "";
const FICHIER = process.env.CHAT_FILE || path.join(__dirname, "chat.json");
const MAX_PAR_CONV = 300;          // messages gardés par conversation
const journal = (...a) => console.log(new Date().toISOString().slice(11, 19), "[chat]", ...a);

/* ───────────── Données ───────────── */
const comptes = new Map();     // ID du joueur (8 chiffres) → { id, nom, hash, cree }
const relations = new Map();   // "de|vers" (ID) → "demande" | "ami" | "bloque"
const groupes = new Map();     // id → { id, nom, membres: [ID], cree }
const convs = new Map();       // clé de conversation → [messages] (privée : "p:a|b" trié ; groupe : "g:id")
const lus = new Map();         // "pseudo|conv vue par lui" → dernier id lu
const votes = new Map();       // Community Vote : "idVote|joueur" → numéro de l'option choisie
const records = new Map();     // "joueur|course|voiture" → { joueur, course, voiture, tf, tour, t } : le classement mondial
let pret = false, compteurId = 0;

// ID du joueur : 8 chiffres au hasard (le premier n'est jamais 0)
function nouvelIdJoueur(){
  let id; do id = String(10000000 + crypto.randomInt(90000000)); while (comptes.has(id));
  return id;
}
const nomDe = id => (comptes.get(id) || {}).nom || "Joueur";
const cleP = (a, b) => "p:" + [a, b].sort().join("|");
const nouvelId = () => Date.now() * 100 + (compteurId = (compteurId + 1) % 100);

/* ───────────── Supabase (ou fichier) ───────────── */
const supa = !!(SUPA_URL && SUPA_CLE);
function entetes(extra){
  const h = { apikey: SUPA_CLE, "Content-Type": "application/json", ...extra };
  if (SUPA_CLE.startsWith("eyJ")) h.Authorization = "Bearer " + SUPA_CLE;     // ancienne clé service_role
  return h;
}
async function lireTable(t, max = Infinity, ordre = ""){
  const lignes = [];
  for (let off = 0; off < max; off += 500){
    const r = await fetch(`${SUPA_URL}/rest/v1/${t}?select=*&limit=500&offset=${off}${ordre}`, { headers: entetes() });
    if (!r.ok) throw new Error(t + " : " + r.status + " " + (await r.text()).slice(0, 200));
    const l = await r.json(); lignes.push(...l);
    if (l.length < 500) break;
  }
  return lignes;
}
// écritures : en file, rejouées si Supabase ne répond pas
const file = []; let enCours = false;
function ecrire(op){ if (!supa){ sauverFichier(); return; } file.push(op); vider(); }
async function vider(){
  if (enCours) return; enCours = true;
  while (file.length){
    const op = file[0];
    try {
      let url = `${SUPA_URL}/rest/v1/${op.t}`, init;
      if (op.f === "upsert"){
        url += op.conflit ? "?on_conflict=" + op.conflit : "";
        init = { method: "POST", headers: entetes({ Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify(op.l) };
      } else if (op.f === "maj"){          // PATCH d'une ligne existante (les stats du profil)
        url += "?" + Object.entries(op.ou).map(([k, v]) => k + "=eq." + encodeURIComponent(v)).join("&");
        init = { method: "PATCH", headers: entetes({ Prefer: "return=minimal" }), body: JSON.stringify(op.l) };
      } else if (op.f === "suppr"){
        url += "?" + Object.entries(op.ou).map(([k, v]) => k + "=eq." + encodeURIComponent(v)).join("&");
        init = { method: "DELETE", headers: entetes({ Prefer: "return=minimal" }) };
      }
      const r = await fetch(url, init);
      if (!r.ok && r.status >= 500) throw new Error(r.status);
      if (!r.ok) journal("Supabase refuse", op.t, r.status, (await r.text()).slice(0, 200));
      file.shift();
    } catch (e){
      journal("Supabase injoignable, on réessaie", e.message);
      await new Promise(ok => setTimeout(ok, 5000));
    }
  }
  enCours = false;
}
let minuteurFichier = null;
function sauverFichier(){
  clearTimeout(minuteurFichier);
  minuteurFichier = setTimeout(() => {
    const o = { comptes: [...comptes.values()], relations: [...relations], groupes: [...groupes.values()],
                messages: [...convs.values()].flat().concat(idees, parties, votesMsgs), lus: [...lus], records: [...records] };
    try { fs.writeFileSync(FICHIER, JSON.stringify(o)); } catch (e) { journal("écriture impossible", e.message); }
  }, 1000);
}
/* La boîte à idées et le journal des parties en ligne : rangés à part (pas
   des discussions), gardés dans la même table que les messages. */
const idees = [], parties = [], votesMsgs = [];
function rangerMessage(m){
  if (m.vers === "x:vote"){
    let o = null; try { o = JSON.parse(m.texte); } catch (e) {}
    const k = o && o.v + "|" + m.de;
    if (o && !votes.has(k)){ votes.set(k, +o.c | 0); votesMsgs.push(m); }
    return "x:vote";
  }
  if (m.vers === "x:idee"){ idees.push(m); if (idees.length > 500) idees.shift(); return "x:idee"; }
  if (m.vers === "x:partie"){ parties.push(m); if (parties.length > 200) parties.shift(); return "x:partie"; }
  const k = m.vers.startsWith("g:") ? m.vers : cleP(m.de, m.vers);
  let l = convs.get(k); if (!l) convs.set(k, l = []);
  l.push(m); if (l.length > MAX_PAR_CONV) l.splice(0, l.length - MAX_PAR_CONV);
  // la mémoire de Render est petite : on ne garde en mémoire que les 30 dernières images de chaque discussion
  let n = 0;
  for (let i = l.length - 1; i >= 0; i--) if (l[i].img && ++n > 30){ delete l[i].img; l[i].imgPerdue = true; }
  return k;
}
async function charger(){
  try {
    if (supa){
      // les messages : seulement les 20 000 plus récents (les anciens restent dans Supabase)
      const [c, r, g, m, l] = await Promise.all([lireTable("dx_comptes"), lireTable("dx_relations"), lireTable("dx_groupes"),
                                                  lireTable("dx_messages", 20000, "&order=id.desc"), lireTable("dx_lus")]);
      // le classement mondial (table ajoutée après : absente, on fait sans)
      try { for (const x of await lireTable("dx_records")) records.set(x.joueur + "|" + x.course + "|" + x.voiture, { joueur: x.joueur, course: x.course, voiture: +x.voiture, tf: +x.tf, tour: x.tour == null ? null : +x.tour, t: +x.t }); }
      catch (e){ journal("pas de table dx_records :", e.message.slice(0, 80)); }
      for (const x of c) comptes.set(String(x.id), { id: String(x.id), nom: x.nom, hash: x.hash, cree: +x.cree, stats: x.stats || null, vu: x.vu == null ? null : +x.vu });
      for (const x of r) relations.set(x.de + "|" + x.vers, x.etat);
      for (const x of g) groupes.set(x.id, { id: x.id, nom: x.nom, membres: x.membres || [], cree: +x.cree });
      m.sort((a, b) => a.id - b.id);
      for (const x of m) rangerMessage(Object.assign({ id: +x.id, de: x.de, vers: x.vers, texte: x.texte, t: +x.t }, x.img ? { img: x.img } : {}));
      for (const x of l) lus.set(x.joueur + "|" + x.conv, +x.dernier);
      journal("Supabase :", comptes.size, "comptes,", m.length, "messages");
    } else if (fs.existsSync(FICHIER)){
      const o = JSON.parse(fs.readFileSync(FICHIER, "utf8"));
      for (const x of o.comptes || []) if (x.id && x.nom) comptes.set(x.id, x);
      for (const [k, v] of o.relations || []) relations.set(k, v);
      for (const x of o.groupes || []) groupes.set(x.id, x);
      for (const x of o.messages || []) rangerMessage(x);
      for (const [k, v] of o.lus || []) lus.set(k, v);
      for (const [k, v] of o.records || []) records.set(k, v);
      journal("fichier :", comptes.size, "comptes");
    } else journal(supa ? "" : "pas de Supabase configuré : les messages seront perdus au redémarrage");
  } catch (e){ journal("chargement impossible :", e.message); }
  pret = true;
}
const chargement = charger();

/* ───────────── Community Vote ─────────────
   Un vote à la fois, ouvert 48 h puis bloqué. Pour voter : avoir fini au
   moins 3 courses (un temps envoyé au classement mondial sur 3 courses
   différentes), une seule voix par compte. Les voix sont gardées dans la
   table des messages (vers = « x:vote »), comme la boîte à idées.          */
const H48 = 48 * 3600000;
const DEBUT_CV1 = +process.env.CV1_DEBUT || Date.UTC(2026, 10, 8, 21, 30);     // 8 novembre 2026, 22 h 30 (Paris) ; CV1_DEBUT : pour les tests
const VOTES = [
  { id: "cv1", debut: DEBUT_CV1, fin: DEBUT_CV1 + H48,
    titre: "Quel circuit doit devenir le prochain circuit à événements ?",
    texte: "Kujota, Bafisson, Thorson, Easydort… chaque tour y réserve une surprise. BlocusHexa et Vozinhato arrivent bientôt — à vous de choisir celui d'après !",
    options: ["Cristiano", "Odysseus", "Monocoule", "Fumbulane"] },
];
function nbCoursesFinies(p){
  const cs = new Set();
  for (const x of records.values()) if (x.joueur === p) cs.add(String(x.course).replace(/ 2$/, ""));
  return cs.size;
}
function resultats(v){
  const r = v.options.map(() => 0);
  for (const [k, c] of votes) if (k.startsWith(v.id + "|") && c >= 0 && c < r.length) r[c]++;
  return r;
}
function etatVote(p){
  const now = Date.now(), finies = nbCoursesFinies(p);
  const fiche = v => ({ id: v.id, titre: v.titre, texte: v.texte, options: v.options, debut: v.debut, fin: v.fin,
                        res: resultats(v), monVote: votes.has(v.id + "|" + p) ? votes.get(v.id + "|" + p) : null });
  const actif = VOTES.find(v => now >= v.debut && now < v.fin);
  const passes = VOTES.filter(v => now >= v.fin).sort((a, b) => b.fin - a.fin).map(fiche);
  return { t: "c-vote", maintenant: now, actif: actif ? fiche(actif) : null, passes, finies, eligible: finies >= 3 };
}
// les résultats en direct : à tous ceux qui sont connectés (au plus une fois par seconde)
let minuteurVote = null;
function diffuserVote(){
  if (minuteurVote) return;
  minuteurVote = setTimeout(() => {
    minuteurVote = null;
    const now = Date.now(), v = VOTES.find(x => now >= x.debut && now < x.fin); if (!v) return;
    const o = { t: "c-vote-res", id: v.id, res: resultats(v) };
    for (const s of enLigne.values()) for (const c of s) envoyer(c, o);
  }, 1000);
}

/* ───────────── Filtre ───────────── */
const INSULTES = ["connard", "connasse", "conasse", "salope", "salaud", "pute", "putain", "encule", "enculé", "enfoiré", "enfoire",
  "batard", "bâtard", "fdp", "ntm", "nique", "niquer", "tg", "ta gueule", "pd", "pédé", "pede", "tapette", "gouine", "negro", "nègre", "negre",
  "bougnoule", "youpin", "mongol", "attardé", "debile", "débile", "abruti", "bite", "couille", "chatte", "branleur", "branleuse", "suce", "sucer",
  "fuck", "fucking", "bitch", "shit", "dick", "nigger", "nigga", "cunt", "whore", "slut", "retard", "kys", "suicide-toi", "creve", "crève", "merde"];
const sansAccent = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
/* Pas convenable ? Les insultes de la liste, et les pires mots même déguisés
   (n1gg@, n.e.g.r.o, niiiigga…) : on regarde le texte « tassé ». */
const PIRES = ["negre", "bougnoul", "youpin", "encul", "salope", "connard", "connass", "fuck", "bitch", "batard"];
function inconvenant(t){
  const b = sansAccent(String(t || "").toLowerCase());
  reInsultes.lastIndex = 0; if (reInsultes.test(b)){ reInsultes.lastIndex = 0; return true; }
  const tasse = b.replace(/[1!|]/g, "i").replace(/3/g, "e").replace(/[4@]/g, "a").replace(/0/g, "o").replace(/[5$]/g, "s").replace(/[^a-z]/g, "");
  const serre = tasse.replace(/(.)\1+/g, "$1");             // niiiigga → niga
  return PIRES.some(m => tasse.includes(m) || serre.includes(m.replace(/(.)\1+/g, "$1")))
    || /nigg/.test(tasse) || /niga(?!ud)/.test(serre) || /(?<!monte)negro(?!ni)/.test(serre);
}
// l'administrateur : le compte « trapezoidululu » le plus ancien (personne d'autre ne peut prendre ce nom)
const estNomAdmin = n => String(n || "").trim().toLowerCase() === "trapezoidululu";
function idAdmin(){
  let a = null; for (const x of comptes.values()) if (estNomAdmin(x.nom) && (!a || x.cree < a.cree)) a = x;
  return a ? a.id : null;
}
const reInsultes = new RegExp("(^|[^a-z0-9])(" + [...new Set(INSULTES.map(x => sansAccent(x.toLowerCase())))]
  .sort((a, b) => b.length - a.length).map(x => x.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&").replace(/ /g, "\\s+")).join("|") + ")(?=$|[^a-z0-9])", "gi");
function filtrer(texte){
  let t = String(texte || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!t) return "";
  // liens, mails, numéros, pseudos de réseaux : on ne partage pas ses infos perso
  t = t.replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[lien masqué]")
       .replace(/\b\S+\.(?:com|fr|net|org|io|gg|be|ch|ca|co|me|tv|xyz|app|link|ly)(?:\/\S*)?\b/gi, "[lien masqué]")
       .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "[adresse masquée]")
       .replace(/(?:\+?\d[\s.\-]?){8,}\d/g, "[numéro masqué]")
       .replace(/(^|\s)@\w{2,}/g, "$1[pseudo masqué]");
  // insultes : on compare sans accents, on masque dans le texte d'origine
  const base = sansAccent(t);
  let out = "", i = 0;
  base.replace(reInsultes, (m, avant, mot, pos) => {
    const deb = pos + avant.length;
    out += t.slice(i, deb) + "*".repeat(mot.length); i = deb + mot.length; return m;
  });
  return out + t.slice(i);
}

/* ───────────── Connexions ───────────── */
const enLigne = new Map();      // pseudo → Set de connexions
// dernière fois en ligne : gardée dans le compte (et dans Supabase), donc même après un redémarrage
const dernierVu = { get: id => (comptes.get(id) || {}).vu || null, set: (id, t) => { const x = comptes.get(id); if (!x) return;
  x.vu = t; ecrire({ f: "maj", t: "dx_comptes", ou: { id }, l: { vu: t } }); } };
const envoyer = (c, o) => { if (c && c.ouvert) c.envoyer(JSON.stringify(o)); };
const aTous = (pseudo, o) => { const s = enLigne.get(pseudo); if (s) for (const c of s) envoyer(c, o); };
const rel = (a, b) => relations.get(a + "|" + b);
const amis = p => [...relations].filter(([k, v]) => v === "ami" && k.startsWith(p + "|")).map(([k]) => k.slice(p.length + 1));
// un ID de joueur (« #48213907 », « 4821 3907 »…) → l'ID s'il existe
const canon = p => { const s = String(p || "").replace(/[#\s.\-]/g, ""); return /^\d{8}$/.test(s) && comptes.has(s) ? s : null; };
const qui = id => ({ id, nom: nomDe(id) });
const avecNom = m => m && Object.assign({}, m, { nom: nomDe(m.de) });

function setRel(de, vers, etat){
  if (etat) relations.set(de + "|" + vers, etat); else relations.delete(de + "|" + vers);
  if (etat) ecrire({ f: "upsert", t: "dx_relations", conflit: "de,vers", l: [{ de, vers, etat }] });
  else ecrire({ f: "suppr", t: "dx_relations", ou: { de, vers } });
}

function nonLus(p){
  const r = {};
  for (const [k, l] of convs){
    let vue = null;
    if (k.startsWith("g:")){ const g = groupes.get(k.slice(2)); if (!g || !g.membres.includes(p)) continue; vue = k; }
    else { const [a, b] = k.slice(2).split("|"); if (a !== p && b !== p) continue; vue = "p:" + (a === p ? b : a); }
    const lu = lus.get(p + "|" + vue) || 0;
    const n = l.filter(m => m.id > lu && m.de !== p).length;
    if (n) r[vue] = n;
  }
  return r;
}
function etatDe(p){
  const amisL = amis(p).map(a => ({ id: a, nom: nomDe(a), enLigne: enLigne.has(a), vu: dernierVu.get(a) || null, enCourse: enLigne.has(a) && !!enCourseDe(a) }));
  const demandes = [...relations].filter(([k, v]) => v === "demande" && k.endsWith("|" + p)).map(([k]) => qui(k.split("|")[0]));
  const envoyees = [...relations].filter(([k, v]) => v === "demande" && k.startsWith(p + "|")).map(([k]) => qui(k.split("|")[1]));
  const bloques = [...relations].filter(([k, v]) => v === "bloque" && k.startsWith(p + "|")).map(([k]) => qui(k.split("|")[1]));
  const gr = [...groupes.values()].filter(g => g.membres.includes(p)).map(g => ({ id: g.id, nom: g.nom, membres: g.membres.map(qui) }));
  // dernier message de chaque conversation (pour trier la liste)
  const derniers = {};
  for (const [k, l] of convs){
    if (!l.length) continue;
    const der = avecNom(l[l.length - 1]); if (der.img){ delete der.img; der.photo = true; }
    if (k.startsWith("g:")){ const g = groupes.get(k.slice(2)); if (g && g.membres.includes(p)) derniers[k] = der; }
    else { const [a, b] = k.slice(2).split("|"); if (a === p || b === p) derniers["p:" + (a === p ? b : a)] = der; }
  }
  return { t: "c-etat", id: p, nom: nomDe(p), amis: amisL, demandes, envoyees, bloques, groupes: gr, nonLus: nonLus(p), derniers };
}
const majEtat = p => { if (enLigne.has(p)) aTous(p, etatDe(p)); };
function presence(p, enL){
  for (const a of amis(p)) aTous(a, { t: "c-presence", id: p, enLigne: enL, vu: dernierVu.get(p) || null });
}

// tous les temps d'une course (une voiture, ou toutes : le meilleur de chacun), du plus rapide au plus lent
function classementMondial(course, voiture){
  const meilleur = new Map();
  for (const x of records.values()){
    if (x.course !== course || (voiture >= 0 && x.voiture !== voiture) || !comptes.has(x.joueur)) continue;
    const a = meilleur.get(x.joueur); if (!a || x.tf < a.tf) meilleur.set(x.joueur, x);
  }
  return [...meilleur.values()].sort((a, b) => a.tf - b.tf);
}

/* ───────────── Stats du profil (venant du jeu : on ne garde que des valeurs simples) ───────────── */
function statsPropres(s){
  if (!s || typeof s !== "object") return null;
  const n = v => Number.isFinite(+v) ? Math.max(0, Math.min(100000, Math.round(+v))) : 0;
  const t = v => String(v || "").replace(/[\u0000-\u001f<>]/g, "").slice(0, 40);
  return { courses: n(s.courses), coursesTotal: n(s.coursesTotal), p2: s.p2 == null ? null : n(s.p2),
           voitures: n(s.voitures), voituresTotal: n(s.voituresTotal), voiture: t(s.voiture),
           liste: Array.isArray(s.liste) ? s.liste.slice(0, 60).map(t) : [],
           jouees: n(s.jouees), podiums: n(s.podiums), victoires: n(s.victoires), maj: Date.now() };
}

/* ───────────── Messages reçus ───────────── */
const refus = (c, raison) => envoyer(c, { t: "c-refus", raison });
// le nom du joueur (celui du jeu) ; vide ou pas convenable : « Joueur 12 »
function nomPropre(n){
  const t = String(n || "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 16);
  return t && filtrer(t) === t && !/^joueur\s*\d*$/i.test(t) ? t : "";
}
function nomParDefaut(){
  let n = 1; for (const x of comptes.values()){ const m = /^Joueur (\d+)$/.exec(x.nom); if (m) n = Math.max(n, +m[1] + 1); }
  return "Joueur " + n;
}
const ligneCompte = x => ({ id: x.id, nom: x.nom, hash: x.hash, cree: x.cree });
function renommer(id, nom){
  const x = comptes.get(id); if (!x || !nom || x.nom === nom) return;
  x.nom = nom; ecrire({ f: "upsert", t: "dx_comptes", conflit: "id", l: [ligneCompte(x)] });
  majEtat(id); for (const a of amis(id)) majEtat(a);
}

// où joue chacun (son groupe multijoueur), pour le bouton « Visionner »
const statuts = new Map();       // ID → { code, idJeu }
let sallesJeu = null;
function enCourseDe(id){
  const st = statuts.get(id); if (!st || !sallesJeu) return null;
  const salle = sallesJeu.get(st.code);
  if (!salle || !salle.sim || !salle.joueurs.some(j => j.id === st.idJeu)) return null;
  return { code: st.code, idJeu: st.idJeu, circuit: salle.circuit };
}
async function recevoir(c, d, ctx){
  await chargement;
  if (ctx && ctx.salles) sallesJeu = ctx.salles;
  if (d.t === "c-entrer"){
    const cle = String(d.cle || ""), idDemande = String(d.id || "").replace(/[#\s]/g, ""), nom = nomPropre(d.nom);
    if (cle.length < 16) return refus(c, "Code secret invalide.");
    const hash = crypto.createHash("sha256").update("dxgp|" + cle).digest("hex");
    let compte = d.nouveau === true ? null : comptes.get(idDemande);
    if (!compte){
      // nouveau compte ; ou bien (« auto ») l'appareil avait ce compte mais le serveur l'a perdu : on le recrée avec le même ID
      const recree = d.nouveau === "auto" && /^\d{8}$/.test(idDemande);
      if (d.nouveau !== true && !recree) return refus(c, "Aucun compte avec cet ID.");
      compte = { id: recree ? idDemande : nouvelIdJoueur(), nom: (estNomAdmin(nom) && idAdmin()) ? nomParDefaut() : nom || nomParDefaut(), hash, cree: Date.now() };
      comptes.set(compte.id, compte);
      ecrire({ f: "upsert", t: "dx_comptes", conflit: "id", l: [ligneCompte(compte)] });
      journal("nouveau compte", compte.id, compte.nom);
    } else if (compte.hash !== hash){
      return refus(c, "Mauvais code secret pour cet ID.");
    } else if (nom && nom !== compte.nom && !(estNomAdmin(nom) && idAdmin() && idAdmin() !== compte.id)) renommer(compte.id, nom);
    const p = compte.id;
    if (c.joueur && c.joueur !== p) sortir(c);
    c.joueur = p; c.chat = true;
    let s = enLigne.get(p); const premier = !s;
    if (!s) enLigne.set(p, s = new Set());
    s.add(c);
    envoyer(c, etatDe(p));
    if (premier) presence(p, true);
    return;
  }
  const p = c.joueur; if (!p) return refus(c, "Pas connecté au chat.");
  // anti-spam : 6 actions par 4 secondes
  const now = Date.now();
  if (d.t === "c-msg" || d.t === "c-inviter" || d.t === "c-ami-demander"){
    c.debit = (c.debit || []).filter(x => now - x < 4000); c.debit.push(now);
    if (c.debit.length > 6) return refus(c, "Doucement ! Attends un peu avant d'envoyer d'autres messages.");
  }

  if (d.t === "c-vote-etat") return envoyer(c, etatVote(p));
  if (d.t === "c-voter"){
    const v = VOTES.find(x => x.id === d.id), choix = +d.choix;
    const non = raison => envoyer(c, Object.assign(etatVote(p), { refus: raison }));
    if (!v) return non("Ce vote n'existe pas.");
    if (now < v.debut || now >= v.fin) return non("Le vote est terminé : les votes sont bloqués.");
    if (!Number.isInteger(choix) || choix < 0 || choix >= v.options.length) return non("Choix invalide.");
    if (nbCoursesFinies(p) < 3) return non("Pour voter, termine d'abord les 3 premières courses.");
    if (votes.has(v.id + "|" + p)) return non("Tu as déjà voté.");
    const m = { id: nouvelId(), de: p, vers: "x:vote", texte: JSON.stringify({ v: v.id, c: choix }), t: now };
    rangerMessage(m);
    ecrire({ f: "upsert", t: "dx_messages", conflit: "id", l: [{ id: m.id, de: m.de, vers: m.vers, texte: m.texte, t: m.t }] });
    journal("vote de", nomDe(p), v.id, v.options[choix]);
    diffuserVote();
    return envoyer(c, Object.assign(etatVote(p), { ok: true }));
  }
  if (d.t === "c-nom"){ const n = nomPropre(d.nom); if (!(estNomAdmin(n) && idAdmin() && idAdmin() !== p)) renommer(p, n); return; }
  // boîte à idées : 5 à 200 caractères, une idée par heure, rien d'insultant
  if (d.t === "c-idee"){
    const texte = String(d.texte || "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, 2000);
    if (texte.length < 5 || texte.length > 200) return envoyer(c, { t: "c-idee-refus", raison: "Ton idée doit faire entre 5 et 200 caractères (" + texte.length + " pour l'instant)." });
    if (inconvenant(texte)) return envoyer(c, { t: "c-idee-refus", raison: "Ton idée ne peut pas être envoyée : elle ne respecte pas les règles de bienséance." });
    const der = [...idees].reverse().find(m => m.de === p);
    if (der && now - der.t < 3600000) return envoyer(c, { t: "c-idee-refus", raison: "Une idée par heure : tu pourras en envoyer une autre dans " + Math.ceil((3600000 - (now - der.t)) / 60000) + " min." });
    const m = { id: nouvelId(), de: p, vers: "x:idee", texte, t: now };
    rangerMessage(m);
    ecrire({ f: "upsert", t: "dx_messages", conflit: "id", l: [{ id: m.id, de: m.de, vers: m.vers, texte: m.texte, t: m.t }] });
    journal("idée de", nomDe(p));
    return envoyer(c, { t: "c-idee-ok" });
  }
  // l'espace Trapezoidu : les idées (avec leur auteur), qui est en ligne, les dernières parties
  if (d.t === "c-admin"){
    if (p !== idAdmin()) return envoyer(c, { t: "c-admin", refuse: true });
    const enL = [...enLigne.keys()].map(id => { const ec = enCourseDe(id); return { id, nom: nomDe(id), enCourse: ec ? String(ec.circuit && ec.circuit.nom || ec.circuit || "") : null }; })
      .sort((a, b) => a.nom.localeCompare(b.nom));
    const groupesJeu = sallesJeu ? [...sallesJeu.values()].map(x => ({ code: x.code, joueurs: x.joueurs.map(j => j.nom), enCourse: !!x.sim, circuit: String(x.circuit && x.circuit.nom || x.circuit || ""), mode: x.mode || "course" })) : [];
    const pt = parties.slice(-60).reverse().map(m => { let o = {}; try { o = JSON.parse(m.texte); } catch (e) {} return Object.assign(o, { t: m.t }); });
    const id2 = idees.slice(-300).reverse().map(m => ({ id: m.id, de: m.de, nom: nomDe(m.de), texte: m.texte, t: m.t }));
    // tous les comptes : nom, création, dernière venue, et le résumé de leur partie
    const tous = [...comptes.values()].map(x => { const st = x.stats || {}; return { id: x.id, nom: x.nom, cree: x.cree || null, vu: enLigne.has(x.id) ? Date.now() : dernierVu.get(x.id) || null, enLigne: enLigne.has(x.id),
      courses: st.courses == null ? null : st.courses, voitures: st.voitures == null ? null : st.voitures, jouees: st.jouees == null ? null : st.jouees, victoires: st.victoires == null ? null : st.victoires }; })
      .sort((a, b) => (b.vu || 0) - (a.vu || 0));
    return envoyer(c, { t: "c-admin", enLigne: enL, comptes: comptes.size, groupes: groupesJeu, parties: pt, idees: id2, tous });
  }
  if (d.t === "c-statut"){
    const code = String(d.code || "").toUpperCase(), idJeu = String(d.idJeu || "").slice(0, 20);
    const avant = JSON.stringify(statuts.get(p) || null);
    if (/^[A-Z]{5}$/.test(code) && idJeu) statuts.set(p, { code, idJeu, c: d.c ? 1 : 0 }); else statuts.delete(p);
    // ses amis voient tout de suite « 🏁 en course » (et le bouton Visionner)
    if (JSON.stringify(statuts.get(p) || null) !== avant) setTimeout(() => { for (const a of amis(p)) majEtat(a); }, 1500);
    return;
  }
  // les stats du jeu (courses ouvertes, voitures…), pour que les autres voient son profil
  if (d.t === "c-stats"){
    const st = statsPropres(d.stats); if (!st) return;
    const x = comptes.get(p); const avant = JSON.stringify(x.stats || null), apres = JSON.stringify(st);
    if (avant === apres) return;
    x.stats = st;
    if (now - (x.statsEcrites || 0) > 20000){ x.statsEcrites = now; ecrire({ f: "maj", t: "dx_comptes", ou: { id: p }, l: { stats: st } }); }
    else { clearTimeout(x.minStats); x.minStats = setTimeout(() => { x.statsEcrites = Date.now(); ecrire({ f: "maj", t: "dx_comptes", ou: { id: p }, l: { stats: x.stats } }); }, 20000); }
    return;
  }
  /* Classement mondial : le meilleur temps de course de chacun, par course
     et par voiture (une course solo terminée l'envoie). */
  if (d.t === "c-record"){
    const course = String(d.course || "").slice(0, 40), voiture = +d.voiture | 0, tf = +d.tf, tour = d.tour == null ? null : +d.tour;
    // (voiture 99 : un temps fait avant le classement mondial, on ne sait pas avec quelle voiture)
    if (!course || voiture < 0 || (voiture > 40 && voiture !== 99) || !(tf > 20 && tf < 3600) || (tour != null && !(tour > 5 && tour < tf))) return;
    if (d.ancien){ const k0 = p + "|" + course + "|99", a0 = records.get(k0); if (!a0 || tf < a0.tf){ const x = { joueur: p, course, voiture: 99, tf, tour, t: now }; records.set(k0, x); ecrire({ f: "upsert", t: "dx_records", conflit: "joueur,course,voiture", l: [x] }); } return; }
    const k = p + "|" + course + "|" + voiture, avant = records.get(k);
    if (!avant || tf < avant.tf || (tour != null && (avant.tour == null || tour < avant.tour))){
      const x = { joueur: p, course, voiture, tf: avant ? Math.min(avant.tf, tf) : tf, tour: avant && avant.tour != null && (tour == null || avant.tour < tour) ? avant.tour : tour, t: now };
      records.set(k, x); ecrire({ f: "upsert", t: "dx_records", conflit: "joueur,course,voiture", l: [x] });
    }
    const cl = classementMondial(course, voiture), rang = cl.findIndex(x => x.joueur === p) + 1;
    envoyer(c, { t: "c-rang", course, voiture, rang, total: cl.length, tf: records.get(k).tf, nouveau: !avant || tf < avant.tf });
    return;
  }
  if (d.t === "c-classement"){
    const course = String(d.course || "").slice(0, 40), voiture = d.voiture == null || d.voiture === "" || +d.voiture < 0 ? -1 : +d.voiture | 0;
    const cl = classementMondial(course, voiture), rang = cl.findIndex(x => x.joueur === p);
    const ligne = (x, i) => ({ rang: i + 1, id: x.joueur, nom: nomDe(x.joueur), voiture: x.voiture, tf: x.tf, tour: x.tour, ami: rel(p, x.joueur) === "ami" });
    envoyer(c, { t: "c-classement", course, voiture, total: cl.length, top: cl.slice(0, 50).map(ligne), moi: rang >= 0 ? ligne(cl[rang], rang) : null });
    return;
  }
  if (d.t === "c-profil"){
    const q = canon(d.id);
    if (!q) return refus(c, "Aucun joueur avec l'ID « " + String(d.id || "").slice(0, 16) + " ».");
    const adm = p === idAdmin();                       // Trapezoidu voit tous les profils, en entier
    if (rel(q, p) === "bloque" && !adm) return refus(c, "Profil indisponible.");
    const x = comptes.get(q), ami = rel(p, q) === "ami" || adm;
    envoyer(c, { t: "c-profil", id: q, nom: x.nom, stats: x.stats || null, cree: x.cree, ami, moi: q === p,
                 demande: rel(p, q) === "demande", enLigne: ami || q === p ? enLigne.has(q) : null, vu: ami ? dernierVu.get(q) || null : null,
                 enCourse: ami && enLigne.has(q) ? enCourseDe(q) : null });
    return;
  }
  if (d.t === "c-ami-demander"){
    const q = canon(d.id);
    if (!q) return refus(c, "Aucun joueur avec l'ID « " + String(d.id || "").slice(0, 16) + " ».");
    if (q === p) return refus(c, "C'est toi !");
    if (rel(q, p) === "bloque" || rel(p, q) === "bloque") return refus(c, "Impossible d'ajouter ce joueur.");
    if (rel(p, q) === "ami") return refus(c, nomDe(q) + " est déjà ton ami.");
    if (rel(q, p) === "demande"){ setRel(p, q, "ami"); setRel(q, p, "ami"); majEtat(p); majEtat(q); return; }   // il l'avait déjà demandé : amis
    setRel(p, q, "demande"); majEtat(p); majEtat(q);
    aTous(q, { t: "c-info", texte: nomDe(p) + " veut être ton ami." });
    return;
  }
  if (d.t === "c-ami-accepter"){
    const q = canon(d.id); if (!q || rel(q, p) !== "demande") return;
    setRel(q, p, "ami"); setRel(p, q, "ami"); majEtat(p); majEtat(q);
    aTous(q, { t: "c-info", texte: nomDe(p) + " a accepté ta demande d'ami." });
    return;
  }
  if (d.t === "c-ami-retirer"){      // refuser une demande, annuler la sienne, ou retirer un ami
    const q = canon(d.id); if (!q) return;
    if (rel(p, q) !== "bloque") setRel(p, q, null);
    if (rel(q, p) !== "bloque") setRel(q, p, null);
    majEtat(p); majEtat(q); return;
  }
  if (d.t === "c-bloquer"){
    const q = canon(d.id); if (!q || q === p) return;
    setRel(p, q, "bloque"); if (rel(q, p) !== "bloque") setRel(q, p, null);
    majEtat(p); majEtat(q); return;
  }
  if (d.t === "c-debloquer"){
    const q = canon(d.id); if (!q || rel(p, q) !== "bloque") return;
    setRel(p, q, null); majEtat(p); return;
  }
  if (d.t === "c-msg" || d.t === "c-inviter"){
    let texte, inv = null;
    if (d.t === "c-inviter"){
      const code = String(d.code || "").toUpperCase();
      if (!/^[A-Z]{5}$/.test(code) || !ctx.salles.has(code)) return refus(c, "Ton groupe multijoueur n'existe plus.");
      texte = "🏁 Viens dans mon groupe multijoueur !"; inv = code;
    } else texte = filtrer(d.texte);
    // une image (le classement d'une course) : JPEG ou PNG, 250 Ko au plus
    const img = !inv && typeof d.img === "string" && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(d.img) && d.img.length <= 250000 ? d.img : null;
    if (d.img && !img) return refus(c, "Image trop grosse ou invalide.");
    if (!texte && !img) return;
    const conv = String(d.conv || "");
    let vers, dest;
    if (conv.startsWith("g:")){
      const g = groupes.get(conv.slice(2));
      if (!g || !g.membres.includes(p)) return refus(c, "Tu n'es pas dans ce groupe.");
      vers = conv; dest = g.membres;
    } else {
      const q = canon(conv.slice(2));
      if (!q || rel(p, q) !== "ami") return refus(c, "Tu ne peux écrire qu'à tes amis.");
      vers = q; dest = [p, q];
    }
    const m = { id: nouvelId(), de: p, vers, texte: texte || "", t: now };
    if (img) m.img = img;
    if (inv) m.inv = inv;
    rangerMessage(m);
    if (!inv) ecrire({ f: "upsert", t: "dx_messages", conflit: "id", l: [Object.assign({ id: m.id, de: m.de, vers: m.vers, texte: m.texte, t: m.t }, img ? { img } : {})] });
    lus.set(p + "|" + (vers.startsWith("g:") ? vers : "p:" + vers), m.id);
    for (const x of dest){
      const vue = vers.startsWith("g:") ? vers : "p:" + (x === p ? vers : p);
      aTous(x, { t: "c-msg", conv: vue, m: avecNom(m) });
    }
    return;
  }
  if (d.t === "c-histo"){
    const conv = String(d.conv || ""); let k;
    if (conv.startsWith("g:")){ const g = groupes.get(conv.slice(2)); if (!g || !g.membres.includes(p)) return; k = conv; }
    else { const q = canon(conv.slice(2)); if (!q) return; k = cleP(p, q); }
    const l = (convs.get(k) || []).filter(m => !m.inv || now - m.t < 30 * 60 * 1000);   // invitations : 30 min
    // pas plus d'1,5 Mo d'un coup (les images du classement pèsent) : les plus vieilles images ne sont pas renvoyées
    const msgs = l.slice(-80).map(avecNom); let poids = 0;
    for (let i = msgs.length - 1; i >= 0; i--){ if (!msgs[i].img) continue; poids += msgs[i].img.length; if (poids > 1500000){ delete msgs[i].img; msgs[i].imgPerdue = true; } }
    envoyer(c, { t: "c-histo", conv, msgs });
    return;
  }
  if (d.t === "c-lu"){
    const conv = String(d.conv || ""), id = +d.id || 0;
    if (!/^(p|g):/.test(conv) || id <= (lus.get(p + "|" + conv) || 0)) return;
    lus.set(p + "|" + conv, id);
    ecrire({ f: "upsert", t: "dx_lus", conflit: "joueur,conv", l: [{ joueur: p, conv, dernier: id }] });
    return;
  }
  if (d.t === "c-groupe-creer"){
    const nom = filtrer(d.nom).slice(0, 30) || "Groupe";
    const membres = [p, ...new Set((d.membres || []).map(canon).filter(q => q && q !== p && rel(p, q) === "ami"))].slice(0, 20);
    if (membres.length < 2) return refus(c, "Choisis au moins un ami.");
    const g = { id: crypto.randomBytes(5).toString("hex"), nom, membres, cree: now };
    groupes.set(g.id, g);
    ecrire({ f: "upsert", t: "dx_groupes", conflit: "id", l: [g] });
    for (const x of membres) majEtat(x);
    envoyer(c, { t: "c-ouvrir", conv: "g:" + g.id });
    return;
  }
  if (d.t === "c-groupe-ajouter"){
    const g = groupes.get(String(d.id || "")), q = canon(d.ami);
    if (!g || !g.membres.includes(p) || !q || rel(p, q) !== "ami" || g.membres.includes(q) || g.membres.length >= 20) return;
    g.membres.push(q); ecrire({ f: "upsert", t: "dx_groupes", conflit: "id", l: [g] });
    for (const x of g.membres) majEtat(x);
    return;
  }
  // renommer le groupe : n'importe quel membre ; tout le monde le voit dans la discussion
  if (d.t === "c-groupe-renommer"){
    const g = groupes.get(String(d.id || "")); if (!g || !g.membres.includes(p)) return;
    const nom = filtrer(d.nom).slice(0, 30).trim(); if (!nom || nom === g.nom) return;
    g.nom = nom; ecrire({ f: "upsert", t: "dx_groupes", conflit: "id", l: [g] });
    for (const x of g.membres) majEtat(x);
    const m = { id: nouvelId(), de: p, vers: "g:" + g.id, texte: "✏️ " + nomDe(p) + " a renommé le groupe : « " + nom + " »", t: now };
    rangerMessage(m);
    ecrire({ f: "upsert", t: "dx_messages", conflit: "id", l: [{ id: m.id, de: m.de, vers: m.vers, texte: m.texte, t: m.t }] });
    for (const x of g.membres) aTous(x, { t: "c-msg", conv: "g:" + g.id, m: avecNom(m) });
    return;
  }
  if (d.t === "c-groupe-quitter"){
    const g = groupes.get(String(d.id || "")); if (!g || !g.membres.includes(p)) return;
    g.membres = g.membres.filter(x => x !== p);
    if (g.membres.length){ ecrire({ f: "upsert", t: "dx_groupes", conflit: "id", l: [g] }); for (const x of g.membres) majEtat(x); }
    else { groupes.delete(g.id); convs.delete("g:" + g.id); ecrire({ f: "suppr", t: "dx_groupes", ou: { id: g.id } }); }
    majEtat(p);
    return;
  }
}
function sortir(c){
  const p = c.joueur; if (!p) return;
  c.joueur = null;
  const s = enLigne.get(p); if (!s) return;
  s.delete(c);
  if (!s.size){ enLigne.delete(p); statuts.delete(p); dernierVu.set(p, Date.now()); presence(p, false); }
}
// une course multijoueur finie : dans le journal (pour l'espace Trapezoidu)
function noterPartie(res){
  try {
    const o = { circuit: String(res.circuit && res.circuit.nom || res.circuit || ""), mode: res.mode || "course",
                joueurs: (res.classement || []).map(x => ({ nom: x.nom, place: x.place, tf: x.tf == null ? null : +(+x.tf).toFixed(3), parti: !!x.parti, elim: x.elim || null })) };
    const m = { id: nouvelId(), de: "serveur", vers: "x:partie", texte: JSON.stringify(o), t: Date.now() };
    rangerMessage(m);
    ecrire({ f: "upsert", t: "dx_messages", conflit: "id", l: [{ id: m.id, de: m.de, vers: m.vers, texte: m.texte, t: m.t }] });
  } catch (e) { journal("partie non notée :", e.message); }
}
module.exports = { recevoir, sortir, filtrer, inconvenant, chargement, noterPartie, stats: () => ({ comptes: comptes.size, enLigne: enLigne.size, supabase: supa }) };
