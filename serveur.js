/* ═══════════════════════════════════════════════════════════════════════
   DX GRAND PRIX — serveur multijoueur
   ─────────────────────────────────────────────────────────────────────
   C'est le serveur qui fait rouler la course : chaque joueur n'envoie que
   ses touches, le serveur calcule toutes les voitures (chocs compris) avec
   le code du jeu lui-même, et renvoie l'état de la course à tout le monde.
   Tous les écrans voient donc la même course.

   Le code du jeu est lu directement sur le site (index.html) : quand le
   jeu est mis à jour, le serveur se met à jour tout seul.

   Aucune dépendance : Node 20+ suffit (WebSocket écrit à la main).
   Variables d'environnement :
     PORT       port d'écoute (Render le fournit)
     GAME_URL   adresse du jeu (par défaut https://dx-grandprix.vercel.app/)
     GAME_FILE  fichier local du jeu (pour les essais), à la place de GAME_URL
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";
const http = require("http");
const crypto = require("crypto");
const vm = require("vm");
const fs = require("fs");

const PORT = +process.env.PORT || 10000;
const GAME_URL = process.env.GAME_URL || "https://dx-grandprix.vercel.app/";
const GAME_FILE = process.env.GAME_FILE || "";
const MAX_VOITURES = 30;         // voitures en course en même temps, tous groupes confondus (le processeur de l'offre gratuite) :
                                 // 2 courses pleines (12 joueurs + Kaimaxus), ou bien plus de petites courses
const MAX_JOUEURS = 12;
const PAS = 1 / 60;              // pas de la physique
const ENVOI_MS = 33;             // état de la course envoyé ~30 fois par seconde

const journal = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ───────────────────────── Code du jeu ───────────────────────── */
let codeJeu = null, versionJeu = 0, chargeA = 0, empreinteJeu = "";
const courseEnCours = () => [...salles.values()].some(x => x.sim);
async function chargerJeu(forcer){
  // relire le site (9 Mo) fige le serveur un instant : jamais pendant une course, sauf s'il le faut vraiment
  if (codeJeu && !forcer && (Date.now() - chargeA < 10 * 60 * 1000 || courseEnCours())) return;
  let html;
  if (GAME_FILE) html = fs.readFileSync(GAME_FILE, "utf8");
  else {
    const r = await fetch(GAME_URL + (GAME_URL.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("jeu introuvable (" + r.status + ")");
    html = await r.text();
  }
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (!scripts.length) throw new Error("script du jeu introuvable");
  const code = scripts.reduce((a, b) => (b.length > a.length ? b : a));
  const m = code.match(/const MULTI_VERSION = (\d+)/);
  let h = 0; for (let i = 0; i < code.length; i += 7) h = (h * 31 + code.charCodeAt(i)) | 0;
  codeJeu = code; versionJeu = m ? +m[1] : 0; chargeA = Date.now(); empreinteJeu = code.length + ":" + h;
  journal("jeu chargé, version multijoueur", versionJeu, "(" + Math.round(code.length / 1e6 * 10) / 10 + " Mo)");
}

/* Un faux navigateur (page, WebGL, stockage), juste assez pour que le jeu
   tourne sans écran. Chaque course a le sien. */
function environnement(){
  const proxy = () => new Proxy(function(){}, { get: (t, k) => k === Symbol.toPrimitive ? (() => 0) : (k in t ? t[k] : proxy()), apply: () => proxy() });
  const elements = {};
  const gl = new Proxy({}, { get: (t, k) => {
    if (typeof k === "string" && /^[A-Z_0-9]+$/.test(k)) return 1;
    if (k === "getShaderParameter" || k === "getProgramParameter") return () => true;
    if (k === "getParameter") return () => [0, 0, 800, 500];
    if (k === "getExtension") return () => null;
    return () => proxy();
  } });
  const faire = id => ({ id, style: {}, dataset: {}, value: "", textContent: "", innerHTML: "", checked: false, disabled: false, children: [],
    classList: { _s: new Set(), add(c){ this._s.add(c); }, remove(c){ this._s.delete(c); }, toggle(){}, contains(c){ return this._s.has(c); } },
    appendChild(c){ this.children.push(c); return c; }, addEventListener(){}, removeEventListener(){}, setAttribute(k, v){ this[k] = v; }, getAttribute(k){ return this[k]; },
    querySelector(){ return faire("q"); }, querySelectorAll(){ return []; }, getBoundingClientRect(){ return { left: 0, top: 0, width: 800, height: 500 }; },
    getContext(t){ return t === "2d" ? proxy() : gl; }, focus(){}, click(){}, remove(){}, closest(){ return null; }, toDataURL(){ return ""; },
    clientWidth: 800, clientHeight: 500, width: 800, height: 500, options: [] });
  const memoire = {};
  const ctx = {
    console, Math, JSON, Date, Array, Object, Number, String, Boolean, Map, Set, WeakMap, Promise, Proxy, Reflect, Symbol, Error, TypeError, RegExp,
    Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Uint8ClampedArray, ArrayBuffer, DataView,
    parseInt, parseFloat, isFinite, isNaN, encodeURIComponent, decodeURIComponent, atob: s => Buffer.from(s, "base64").toString("binary"), btoa: s => Buffer.from(s, "binary").toString("base64"),
    TextDecoder, TextEncoder, URLSearchParams, structuredClone, queueMicrotask, Intl,
    document: { getElementById: id => (elements[id] = elements[id] || faire(id)), createElement: t => faire(t), body: faire("body"), head: faire("head"),
                addEventListener(){}, querySelectorAll: () => [], querySelector: () => faire("q"), documentElement: faire("html") },
    addEventListener(){}, removeEventListener(){}, requestAnimationFrame: () => 0, cancelAnimationFrame(){}, matchMedia: () => ({ matches: false, addEventListener(){} }),
    innerWidth: 800, innerHeight: 500, devicePixelRatio: 1, performance: { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 },
    alert(){}, confirm: () => true, Image: function(){}, AudioContext: undefined, navigator: { userAgent: "serveur", clipboard: { writeText(){} } },
    localStorage: { getItem: k => memoire[k] ?? null, setItem: (k, v) => { memoire[k] = String(v); }, removeItem: k => { delete memoire[k]; } },
    sessionStorage: { getItem: () => null, setItem(){}, removeItem(){} },
    setInterval: () => 0, clearInterval(){}, setTimeout: () => 0, clearTimeout(){},
    location: { reload(){}, search: "", href: "" }, URL: { createObjectURL(){ return ""; } }, Blob: function(){}, fetch: () => Promise.reject(new Error("hors ligne")),
    WebSocket: undefined, RTCPeerConnection: undefined,
  };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  return vm.createContext(ctx);
}

/* Ce qui est ajouté au jeu pour le serveur : préparer une course où toutes
   les voitures sont des joueurs (plus Kaimaxus), faire un pas de physique,
   et lire l'état de la course. */
const AJOUT = String.raw`
;globalThis.__srv = (() => {
  const SRV = {};
  // sur le serveur rien n'est dessiné : pas de décor ni de ciel à construire
  construireDecor = () => ({ route: {}, rails: {}, paysage: {}, facades: {}, grillage: {}, foule: {}, drapeaux: {}, reliefs: {}, enseignes: {} });
  construireCiel = () => ({});
  decor = null;
  /* Plusieurs groupes partagent le même moteur : chacun a son état de course
     (jeu, piste, largeur), qu'on remet en place avant chaque calcul. */
  SRV.activer = S => {
    if (S.jeu){ for (const k of Object.keys(jeu)) if (!(k in S.jeu)) delete jeu[k]; Object.assign(jeu, S.jeu); }
    piste = S.piste; DEMI_PISTE = S.demi; decor = null;
  };
  SRV.sauver = S => { S.jeu = Object.assign({}, jeu); S.piste = piste; S.demi = DEMI_PISTE; };
  SRV.version = typeof MULTI_VERSION !== "undefined" ? MULTI_VERSION : 0;
  SRV.circuits = () => coursesMulti().map(c => c.nom);
  SRV.preparer = (nomCircuit, grille, kaimaxus, placeKai) => {
    const i = CIRCUITS.findIndex(c => c.nom === nomCircuit && !c.essai);
    if (i < 0) throw new Error("course inconnue");
    const g = grille.map(j => Object.assign({}, j, { coul: MULTI_COULEURS[j.coul % MULTI_COULEURS.length] }));
    const p = g[0];
    jeu.multi = { grille: g, moi: p.id, maPlace: p.place, maCouleur: p.coul, monNom: p.nom, kaimaxus: !!kaimaxus, placeKai };
    jeu.adversaires = kaimaxus ? ["Kaimaxus"] : [];
    jeu.partieCourse = 1; jeu.circuit = i; jeu.pauseMulti = false;
    reseau.hote = true;                       // Kaimaxus roule ici, comme une vraie voiture
    preparerCourse(i);
    for (const v of jeu.voitures){
      if (v.distant){ v.distant = false; v.joueur = true; v.idJ = v.idDistant; v.modele = 0; v.vmax = VOITURES[0].R.vmax; }
      else if (v.joueur) v.idJ = p.id;
      if (v.joueur){ v.humain = true; v.tour = -1; v.dirL = 0; }
      if (v.kaimaxus) v.idJ = "kaimaxus";
    }
    jeu.joueur = null;
    return { tours: CIRCUITS[i].tours };
  };
  const arrivee = v => {
    const R = VOITURES[0].R;
    Object.assign(v, { R: Object.assign({}, R, { vmax: R.vmax * 0.5 }), adresse: 0.3, irregulier: 0.02,
      s: v.distance, vlat: 0, trouble: 0, lacetChoc: 0, capLisse: 0, bruit: 0, horsT: 0, ligneIdx: 0, rayonRoue: v.rayonRoue || 0.33, enArrivee: true });
  };
  SRV.etape = (dt, E) => {
    const def = CIRCUITS[jeu.circuit];
    if (jeu.phase === "compte"){
      jeu.compte -= dt;
      for (const v of jeu.voitures) v.distance = v.s;
      classer();
      if (jeu.compte <= -0.6) jeu.phase = "course";
      return;
    }
    if (jeu.phase !== "course") return;
    jeu.chrono += dt;
    const H = [];
    for (const v of jeu.voitures){
      v.tempsTour += dt;
      if (!v.humain){ majIA(v, dt); continue; }
      H.push(v);
      if (v.parti) continue;                         // parti : sa voiture ne bouge plus (les autres la voient disparaître)
      if (v.enArrivee){ majIA(v, dt); continue; }
      const e = E[v.idJ] || {};
      cmd.gaz = e.g ? 1 : 0; cmd.frein = e.f ? 1 : 0; cmd.dir = Math.max(-1, Math.min(1, +e.d || 0)); cmd.dirLisse = v.dirL || 0;
      if (e.e && v.horsPiste && !(v.retour > 0)) v.retour = 1.0;
      jeu.joueur = v; majJoueur(v, dt); v.dirL = cmd.dirLisse;
      if (v.tour >= def.tours && v.tempsFinal == null){ v.tempsFinal = jeu.chrono; arrivee(v); }
    }
    for (const h of H){ h.vLatJ = (h.lat - (h.latPrecC ?? h.lat)) / Math.max(dt, 1e-4); h.latPrecC = h.lat; }
    jeu.joueur = null;
    /* Entre deux joueurs, le coup de volant vers l'autre le pousse comme on
       pousse un bot : il part en glissade de côté (dans l'herbe s'il est au bord). */
    for (const h of H) if (h.pousseJ > 0) h.pousseJ -= dt;
    for (let i = 0; i < H.length; i++) for (let j = 0; j < H.length; j++){
      const a = H[i], b = H[j];
      if (i === j || a.parti || b.parti || a.tempsFinal != null || b.tempsFinal != null || b.pousseJ > 0) continue;
      const dx = b.x - a.x, dz = b.z - a.z; if (dx*dx + dz*dz > 25) continue;
      const ca = Math.cos(a.cap), sa = Math.sin(a.cap);
      const avant = dx*sa + dz*ca, cote = dx*ca - dz*sa;
      if (Math.abs(avant) > 4.3 || Math.abs(cote) > 2.0) continue;
      const versLui = Math.sign(b.lat - a.lat) || 1, elan = (a.vLatJ || 0) * versLui;
      if (elan <= 1.2) continue;
      const sB = Math.sign(cote) || 1, force = Math.min(10, 2 + elan * 1.3);
      b.deriveX = ca * sB * force; b.deriveZ = -sa * sB * force; b.deriveT = 0.6;
      b.cap += sB * 0.05; b.capVit = b.cap; b.pousseJ = 0.4; b.nPousse = (b.nPousse || 0) + 1;
      a.v *= 0.97;
    }
    collisions(dt);
    classer(); calculerAspiration(dt); noterPassages();
  };
  const r3 = x => Math.round((x || 0) * 1000) / 1000;
  SRV.etat = () => jeu.voitures.map(v => [v.idJ, r3(v.x), r3(v.y), r3(v.z), r3(v.cap), r3(v.tangage), r3(v.roulis), r3(v.braquage),
                                          r3(v.v), r3(v.lat), r3(v.distance), v.tour, v.meilleur == null ? null : r3(v.meilleur),
                                          v.tempsFinal == null ? null : r3(v.tempsFinal), v.horsPiste ? 1 : 0, v.retour > 0 ? 1 : 0,
                                          v.nPousse || 0, r3(v.deriveX), r3(v.deriveZ)]);
  SRV.phase = () => jeu.phase;
  SRV.chrono = () => jeu.chrono;
  SRV.toutFini = () => jeu.voitures.every(v => !v.humain || v.tempsFinal != null || v.parti);
  SRV.depart = id => { const v = jeu.voitures.find(x => x.idJ === id); if (v){ v.parti = true; v.humain = true; v.x = v.z = 1e6; v.distance = -1e6; v.v = 0; } };
  return SRV;
})();
`;

/* Un seul moteur de jeu pour tout le serveur (le charger coûte cher) ; il
   est refait quand le jeu du site change de version. */
let moteur = null;
async function moteurAJour(){
  await chargerJeu();
  /* refait quand le code du jeu a changé (même sans changer de version), pour
     que le serveur roule exactement comme les joueurs — mais pas pendant une
     course : ça bloquerait tout le monde plusieurs secondes */
  if (!moteur || moteur.version !== versionJeu || (moteur.empreinte !== empreinteJeu && !courseEnCours())){
    const t0 = Date.now();
    const ctx = environnement();
    vm.runInContext(codeJeu + AJOUT, ctx, { filename: "jeu.js" });
    moteur = { sim: ctx.__srv, version: versionJeu, empreinte: empreinteJeu, circuits: ctx.__srv.circuits() };
    journal("moteur prêt en", Date.now() - t0, "ms");
  }
  return moteur;
}

/* ───────────────────────── Salles (groupes) ───────────────────────── */
const salles = new Map();     // code → salle
const COULEURS = 12;
const codeAleatoire = () => Array.from({ length: 5 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 24)]).join("");
const nid = () => crypto.randomBytes(6).toString("hex");

function envoyer(c, msg){ if (c && c.ouvert) c.envoyer(JSON.stringify(msg)); }
function diffuser(salle, msg){ const s = JSON.stringify(msg); for (const j of salle.joueurs) if (j.c.ouvert) j.c.envoyer(s); }
function infoSalon(salle){
  return { t: "salon", v: versionJeu, code: salle.code, circuit: salle.circuit, kaimaxus: salle.kaimaxus, enCourse: !!salle.sim,
           joueurs: salle.joueurs.map(j => ({ id: j.id, nom: j.nom, coul: j.coul, hote: j === salle.joueurs[0], lien: "serveur" })) };
}
function majSalon(salle){ diffuser(salle, infoSalon(salle)); }

function quitter(c){
  const salle = c.salle; if (!salle) return;
  c.salle = null;
  const j = salle.joueurs.find(x => x.c === c); if (!j) return;
  salle.joueurs = salle.joueurs.filter(x => x !== j);
  if (salle.sim){ try { salle.sim.activer(salle.S); salle.sim.depart(j.id); salle.sim.sauver(salle.S); } catch (e) {} diffuser(salle, { t: "parti", id: j.id }); }
  if (!salle.joueurs.length){ fermerSalle(salle); return; }
  majSalon(salle);
}
function fermerSalle(salle){
  if (salle.boucle) clearInterval(salle.boucle);
  salle.sim = null; salles.delete(salle.code);
  journal("groupe", salle.code, "fermé");
}

async function recevoir(c, d){
  if (!d || typeof d !== "object") return;
  if (d.t === "ping"){ envoyer(c, { t: "pong", t0: d.t0 }); return; }
  if (d.t === "creer" || d.t === "rejoindre"){
    // il vient de se réveiller : préparer le jeu prend un moment, on prévient le joueur
    if (!moteur || moteur.version !== versionJeu || d.v !== versionJeu) envoyer(c, { t: "attente" });
    try { await chargerJeu(); if (d.v !== versionJeu) await chargerJeu(true); await moteurAJour(); }
    catch (e){ envoyer(c, { t: "refus", raison: "Le serveur n'arrive pas à lire le jeu sur le site : " + e.message }); return; }
    if (d.v !== versionJeu){ envoyer(c, { t: "refus", raison: "Ta version du jeu n'est pas la même que celle du site : recharge la page (sur téléphone, ferme et rouvre l'onglet)." }); return; }
    quitter(c);
    const nom = String(d.nom || "Joueur").slice(0, 16);
    if (d.t === "creer"){
      let code; do code = codeAleatoire(); while (salles.has(code));
      const salle = { code, joueurs: [], circuit: moteur.circuits[0], listeCircuits: moteur.circuits, moteur, kaimaxus: true, sim: null, S: null, boucle: null, entrees: {} };
      salles.set(code, salle);
      const j = { id: nid(), nom, coul: 0, c };
      salle.joueurs.push(j); c.salle = salle; c.id = j.id;
      envoyer(c, { t: "bienvenue", id: j.id, code, hote: true });
      majSalon(salle);
      journal("groupe", code, "créé par", nom);
      return;
    }
    const salle = salles.get(String(d.code || "").toUpperCase());
    if (!salle){ envoyer(c, { t: "refus", raison: "Aucun groupe avec ce code." }); return; }
    if (salle.joueurs.length >= MAX_JOUEURS){ envoyer(c, { t: "refus", raison: "Le groupe est plein (12 joueurs maximum)." }); return; }
    if (salle.sim){ envoyer(c, { t: "refus", raison: "Une course est en cours : réessaie dans un moment." }); return; }
    const prises = new Set(salle.joueurs.map(x => x.coul)); let coul = 0; while (prises.has(coul)) coul++;
    const j = { id: nid(), nom, coul: coul % COULEURS, c };
    salle.joueurs.push(j); c.salle = salle; c.id = j.id;
    envoyer(c, { t: "bienvenue", id: j.id, code: salle.code, hote: false });
    majSalon(salle);
    return;
  }
  const salle = c.salle; if (!salle) return;
  const hote = salle.joueurs[0] && salle.joueurs[0].c === c;
  if (d.t === "quitte"){ quitter(c); return; }
  if (d.t === "abandon"){
    if (salle.sim){ try { salle.sim.activer(salle.S); salle.sim.depart(c.id); salle.sim.sauver(salle.S); } catch (e) {} diffuser(salle, { t: "parti", id: c.id }); }
    return;
  }
  if (d.t === "in"){ salle.entrees[c.id] = { g: d.g ? 1 : 0, f: d.f ? 1 : 0, d: Math.max(-1, Math.min(1, +d.d || 0)), e: d.e ? 1 : 0 }; return; }
  if (d.t === "choix" && hote && !salle.sim){
    if (d.circuit && (salle.listeCircuits || []).includes(d.circuit)) salle.circuit = d.circuit;
    if (typeof d.kaimaxus === "boolean") salle.kaimaxus = d.kaimaxus;
    majSalon(salle); return;
  }
  if (d.t === "lancer" && hote && !salle.sim){ lancerCourse(salle); return; }
  if (d.t === "retour" && hote){ finCourse(salle); return; }
}

function lancerCourse(salle){
  const n = salle.joueurs.length + (salle.kaimaxus ? 1 : 0);
  let enCourse = 0;
  for (const x of salles.values()) if (x.sim) enCourse += x.nVoitures || 0;
  if (enCourse + n > MAX_VOITURES){
    diffuser(salle, { t: "refus-course", raison: "Trop de courses en même temps sur le serveur : réessaie dans une minute." }); return;
  }
  salle.nVoitures = n;
  const places = Array.from({ length: n }, (_, k) => k);
  for (let k = n - 1; k > 0; k--){ const r = Math.floor(Math.random() * (k + 1)); [places[k], places[r]] = [places[r], places[k]]; }
  const grille = salle.joueurs.map((j, k) => ({ id: j.id, nom: j.nom, coul: j.coul, place: places[k] }));
  const placeKai = salle.kaimaxus ? places[n - 1] : n;
  // le moteur du groupe : celui du jeu actuel (refait si le site a changé entre-temps)
  if (salle.moteur !== moteur && moteur) salle.moteur = moteur;
  const sim = salle.moteur.sim, S = {};
  try { sim.activer(S); sim.preparer(salle.circuit, grille, salle.kaimaxus, placeKai); sim.sauver(S); }
  catch (e){ diffuser(salle, { t: "refus-course", raison: "Erreur du serveur : " + e.message }); journal("erreur", e); return; }
  salle.sim = sim; salle.S = S; salle.entrees = {}; salle.finiA = 0;
  diffuser(salle, { t: "depart", type: "depart", v: versionJeu, circuit: salle.circuit, grille, kaimaxus: salle.kaimaxus, placeKai, serveur: true });
  journal("groupe", salle.code, "course", salle.circuit, n, "voitures");
  // boucle de la course : physique à 60 pas par seconde, état envoyé ~30 fois par seconde
  let t = Date.now(), reste = 0, dernierEnvoi = 0;
  salle.boucle = setInterval(() => {
    const now = Date.now();
    /* Le serveur a coincé (plus de 0,15 s sans tour) : on attend le tour
       suivant pour lire d'abord les touches arrivées entre-temps, sinon il
       rattrapait le temps perdu avec les touches d'il y a 3 secondes. */
    if (now - t > 150 && !salle.reporte){ salle.reporte = true; return; }
    salle.reporte = false;
    // puis on rattrape le temps perdu (jusqu'à 3 s) pour rester à l'heure des joueurs
    reste += Math.min(3, (now - t) / 1000); t = now;
    try {
      if (!salle.sim) return;
      sim.activer(S);
      while (reste >= PAS){ sim.etape(PAS, salle.entrees); reste -= PAS; }
      if (now - dernierEnvoi >= ENVOI_MS){
        dernierEnvoi = now;
        const m = JSON.stringify({ t: "e", ts: now, ch: Math.round(sim.chrono() * 1000) / 1000, c: sim.etat() });
        for (const j of salle.joueurs) if (j.c.ouvert && !(j.c.engorge && j.c.engorge())) j.c.envoyer(m);
      }
      // tout le monde est arrivé (ou 90 s après le premier) : la course s'arrête côté serveur
      if (sim.toutFini()){ if (!salle.finiA) salle.finiA = now; if (now - salle.finiA > 8000) finCourse(salle); }
      else if (sim.phase() === "course"){
        const arrives = sim.etat().filter(v => v[0] !== "kaimaxus" && v[13] != null).length;
        if (arrives && !salle.premierA) salle.premierA = now;
        if (salle.premierA && now - salle.premierA > 90000) finCourse(salle);
      }
      if (salle.sim) sim.sauver(S);
    } catch (e){ journal("erreur de simulation", e); finCourse(salle); }
  }, 1000 / 60);
}
function finCourse(salle){
  if (salle.boucle) clearInterval(salle.boucle);
  salle.boucle = null; salle.sim = null; salle.S = null; salle.premierA = 0;
  if (salles.has(salle.code)) majSalon(salle);
}

/* ───────────────────────── WebSocket (écrit à la main) ───────────────────────── */
function trame(texte){
  const b = Buffer.from(texte); let h;
  if (b.length < 126) h = Buffer.from([0x81, b.length]);
  else if (b.length < 65536){ h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(b.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(b.length), 2); }
  return Buffer.concat([h, b]);
}
const serveur = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end("DX Grand Prix : serveur multijoueur en marche · version " + versionJeu + " · " + salles.size + " groupe(s)\n");
});
serveur.on("upgrade", (req, sock) => {
  const cle = req.headers["sec-websocket-key"];
  if (!cle){ sock.destroy(); return; }
  const accept = crypto.createHash("sha1").update(cle + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  sock.setNoDelay(true);
  const c = { ouvert: true, salle: null, id: null, vu: Date.now(),
    envoyer(t){ if (this.ouvert) try { sock.write(trame(t)); } catch (e) {} },
    // connexion qui n'avale plus (4G faible) : on saute des états plutôt que de les empiler (sinon ils arrivent avec des secondes de retard)
    engorge(){ return sock.writableLength > 6000; } };
  let buf = Buffer.alloc(0), morceaux = [];
  sock.on("data", d => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2){
      const fin = buf[0] & 0x80, op = buf[0] & 15, masque = buf[1] & 0x80;
      let len = buf[1] & 127, off = 2;
      if (len === 126){ if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127){ if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1e6){ sock.destroy(); return; }
      const debut = off + (masque ? 4 : 0);
      if (buf.length < debut + len) return;
      let p = buf.subarray(debut, debut + len);
      if (masque){ const m = buf.subarray(off, off + 4); p = Buffer.from(p); for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3]; }
      buf = buf.subarray(debut + len);
      c.vu = Date.now();
      if (op === 8){ fermer(); return; }
      if (op === 9){ try { sock.write(Buffer.concat([Buffer.from([0x8A, p.length]), p])); } catch (e) {} continue; }
      if (op === 10) continue;
      if (op === 1 || op === 0){
        morceaux.push(Buffer.from(p));
        if (!fin) continue;
        const texte = Buffer.concat(morceaux).toString(); morceaux = [];
        let msg; try { msg = JSON.parse(texte); } catch (e) { continue; }
        recevoir(c, msg).catch(e => journal("erreur", e));
      }
    }
  });
  const fermer = () => { if (!c.ouvert) return; c.ouvert = false; quitter(c); try { sock.end(); } catch (e) {} };
  sock.on("close", fermer); sock.on("error", fermer); sock.on("end", fermer);
});
// sans nouvelles depuis 10 s (page fermée, téléphone en veille) : le joueur est sorti
setInterval(() => {
  for (const salle of salles.values()) for (const j of salle.joueurs)
    if (Date.now() - j.c.vu > 10000){ j.c.ouvert = false; quitter(j.c); }
}, 2000);

// utilisé par les essais : require("./serveur.js") donne le moteur sans lancer le serveur
if (require.main !== module){ module.exports = { moteurAJour }; return; }
serveur.listen(PORT, () => {
  journal("serveur DX Grand Prix sur le port", PORT);
  moteurAJour().catch(e => journal("jeu pas encore chargé :", e.message));
});
