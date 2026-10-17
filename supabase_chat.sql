-- Tables du chat de DX Grand Prix (à coller une fois dans Supabase → SQL Editor → Run).
-- Seul le serveur Render y accède, avec la clé secrète : la sécurité par ligne (RLS)
-- est activée sans aucune règle, donc la clé publique du jeu ne peut RIEN lire ici.
drop table if exists dx_comptes, dx_relations, dx_groupes, dx_messages, dx_lus;

create table dx_comptes   (id text primary key, nom text not null, hash text not null, cree bigint, stats jsonb);
create table dx_relations (de text not null, vers text not null, etat text not null, primary key (de, vers));
create table dx_groupes   (id text primary key, nom text, membres jsonb, cree bigint);
create table dx_messages  (id bigint primary key, de text not null, vers text not null, texte text not null, t bigint, img text);
create table dx_lus       (joueur text not null, conv text not null, dernier bigint, primary key (joueur, conv));

alter table dx_comptes   enable row level security;
alter table dx_relations enable row level security;
alter table dx_groupes   enable row level security;
alter table dx_messages  enable row level security;
alter table dx_lus       enable row level security;

-- Profils (ajouté après) : les stats du jeu de chaque joueur
alter table dx_comptes add column if not exists stats jsonb;

-- Classement mondial (ajouté après) : le meilleur temps de chacun par course et par voiture
create table if not exists dx_records (joueur text not null, course text not null, voiture int not null, tf double precision not null, tour double precision, t bigint, primary key (joueur, course, voiture));
alter table dx_records enable row level security;

-- Dernière connexion (ajouté après)
alter table dx_comptes add column if not exists vu bigint;
