# DX Grand Prix — serveur multijoueur

Le serveur fait rouler les courses multijoueur : chaque joueur envoie ses touches,
le serveur calcule toutes les voitures (chocs compris) avec le code du jeu lu
directement sur le site, et renvoie l'état de la course à tout le monde.

- Démarrage : `npm start` (Node 20 ou plus, aucune dépendance)
- `GAME_URL` : adresse du jeu (par défaut https://dx-grandprix.vercel.app/)
- Hébergé sur Render (offre gratuite) : il s'endort après 15 min sans joueurs
  et met environ une minute à se réveiller.
