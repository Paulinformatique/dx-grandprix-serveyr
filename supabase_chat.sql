-- Tables du chat de DX Grand Prix (à coller une fois dans Supabase → SQL Editor → Run).
-- Seul le serveur Render y accède, avec la clé secrète : la sécurité par ligne (RLS)
-- est activée sans aucune règle, donc la clé publique du jeu ne peut RIEN lire ici.
drop table if exists dx_comptes, dx_relations, dx_groupes, dx_messages, dx_lus;

create table dx_comptes   (id text primary key, nom text not null, hash text not null, cree bigint);
create table dx_relations (de text not null, vers text not null, etat text not null, primary key (de, vers));
create table dx_groupes   (id text primary key, nom text, membres jsonb, cree bigint);
create table dx_messages  (id bigint primary key, de text not null, vers text not null, texte text not null, t bigint, img text);
create table dx_lus       (joueur text not null, conv text not null, dernier bigint, primary key (joueur, conv));

alter table dx_comptes   enable row level security;
alter table dx_relations enable row level security;
alter table dx_groupes   enable row level security;
alter table dx_messages  enable row level security;
alter table dx_lus       enable row level security;
