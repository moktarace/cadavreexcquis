# Cadavre Exquis

PWA de création collective asynchrone : des histoires en quatre cases (yonkoma), dessinées à plusieurs sur une semaine. Voir [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) pour les décisions techniques.

## Lancer

```bash
npm install
npm run dev        # http://localhost:5173
npm start          # alias de npm run dev
npm test           # tests du domaine, de l'éditeur, du routeur et des thèmes SQL
npm run build      # typecheck + build PWA dans dist/
npm run preview    # sert le build (service worker actif, installation PWA testable)
npm run icons      # régénère public/icons/*
npm run db:check   # exécute les migrations dans PGlite et vérifie règles de jeu et RLS
npm run db:themes  # régénère supabase/migrations/0003_themes.sql
npm run db:apply   # applique les migrations sur le projet Supabase (SUPABASE_DB_URL requis)
```

Le service worker n'est enregistré qu'en build de production : tester l'installation avec `build` + `preview`.

## Variables d'environnement

Voir [.env.example](.env.example). Copier en `.env.local` (ignoré par git).

| Variable | Portée | Usage |
| --- | --- | --- |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | client | accès Supabase; la clé publishable est publique par conception, la sécurité repose sur les politiques RLS |
| `SUPABASE_DB_URL` | outil local seulement | chaîne de connexion Postgres pour `npm run db:apply`; ne jamais la commiter |
| `VITE_VAPID_PUBLIC_KEY` | client | abonnement Web Push |
| `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `DISPATCH_SECRET` | serveur seulement (secrets de la fonction `dispatch`) | signature des notifications, authentification de l'appel de pg_cron |

`npm run push:setup` génère ces valeurs une fois dans `.env.local` (sans les afficher). Penser à remplacer `VAPID_SUBJECT` par une vraie adresse `mailto:`. La clé de service Supabase n'est pas à renseigner : elle est fournie automatiquement aux Edge Functions.

## Base de données (Supabase)

Trois migrations dans [supabase/migrations](supabase/migrations) :

1. `0001_init.sql` : tables, index, fonctions `join_game` et `publish_contribution`, RLS.
2. `0002_app.sql` : profil automatique à l'inscription, vue `contribution_cards`, `current_game`, chemins et sous-arbres, buckets de stockage.
3. `0003_themes.sql` : **généré** (thèmes et parties de chaque semaine 2026–2030, donc aucun changement de semaine à gérer à la main). Regénérer avant fin 2030.
4. `0004_notifications.sql` : file d'attente des notifications, regroupement, heures de silence, annonce du nouveau thème, réservation atomique pour l'envoi; remplace `publish_contribution` pour produire les événements.
5. `0005_png_only.sql` : supprime le projet JSON (politiques du bucket `projects`, type d'asset, colonne `format_version`).
6. `0006_discovery.sql` : `archive_weeks()` et `archive_highlights()` (lecture des archives sans limite arbitraire, jamais la partie courante ni une partie privée), ordre total de `contribution_subtree`.
7. `0007_progress.sql` : `contribution_progress()`, ce que les autres ont fait de tes dessins (suites, histoire terminée), pour « Mes dessins ».

Mise en place sur un projet Supabase :

1. Authentication > Sign In / Providers : activer **Allow anonymous sign-ins**.
2. Appliquer les migrations : soit coller les trois fichiers dans l'éditeur SQL du tableau de bord, dans l'ordre; soit ajouter `SUPABASE_DB_URL` dans `.env.local` (Project Settings > Database > Connection string) puis `npm run db:apply`.

`npm run db:check` exécute ces migrations dans PGlite avec des rôles et une RLS simulés (34 vérifications : profil automatique, partie courante, auto-continuation refusée, case 4 finale, projet réutilisé ou d'autrui refusé, insertion directe refusée, projet publié figé, signalements, notifications, archives, pagination déterministe). Cela ne remplace pas un test sur la vraie base; les accès réellement concurrents et le stockage ne sont pas testés.

## Interface (refonte rétro-console)

Direction artistique « console portable » allégée : fond crème pointillé, icônes pixel art en SVG (aucun emoji, aucun asset tiers), micro-animations désactivées si l'utilisateur réduit les animations. Les bordures épaisses, reliefs et couleurs vives sont réservés aux actions importantes (Créer, Continuer, Publier, palette) et aux dessins des joueurs; les panneaux décoratifs utilisent un trait fin.

- **Design system** : `src/ui/tokens.css` (couleurs, rayons, ombres, espacements, zones tactiles), `base.css`, `components.css`, `screens.css`, `src/editor/editor.css`.
- **Composants** (`src/ui`) : `ToyButton`, `ToyCard`, `ToyTabs`, `ToyDialog`, `ToyToggle`, `ToySpinner`, `PixelIcon` (+ `Mascot`), `ColorSwatch`, `StoryThumbnail`, `BranchNode`, `WeeklyThemeCard`, `Dock`, `ScreenHeader`, `Swiper` (feuilletage horizontal natif), `ThreadPeek` (le fil d'une histoire).
- **Principe** : « Découvre un dessin. Imagine la suite. Passe le relais ! » Les arbres, branches, profondeurs et salles restent invisibles pendant une partie normale.
- **Navigation** : dock à trois entrées, **Jouer** (bouton central, l'action principale), **Lire** et **Mes dessins**. L'accueil (`#/`) présente le thème, la phrase « À plusieurs, dessinez des histoires en 4 cases. Chacun imagine la suite du dessin d'un autre ! » et deux actions sous-titrées : « Continuer une histoire » (« Dessine la suite de quelqu'un ! », mène à Jouer) et « Commencer une histoire » (« Imagine la première case ! »); Réglages par l'engrenage de l'accueil.
- **Jouer** (`#/play`, `#/play/<case>`) : une case que le joueur peut légalement continuer dans sa salle (jamais la sienne, jamais une case finale), avec l'histoire qui la précède (cases précédentes à un tap), « À toi de dessiner la case N ! » avec le rôle de la case (1 « Imagine le début de l'histoire ! », 2 « Dessine ce qui se passe ensuite ! », 3 « L'histoire approche de sa fin ! », 4 « C'est la dernière case ! Imagine la fin de l'histoire. »), le bouton « Dessiner la suite » (« Dessiner la fin » pour la case 4) toujours visible au-dessus du dock et « Une autre histoire ». Les propositions sont tirées parmi les dessins sans suite (sinon parmi tous). Options secondaires : « Commencer une histoire » et « Parcourir les cases » (`#/browse` : niveaux 1/2/3, au hasard, pagination par 12, lecture jamais tronquée à 1 000 lignes).
- **Rien à continuer** : salle vide → « Tu es le premier à jouer ! »; seulement ses propres dessins → « En attente d'autres joueurs », avec « Inviter quelqu'un à continuer mon dessin » (partage du système ou lien copié, vers `#/case/<id>`). Aucun joueur ni contenu simulé.
- **Éditeur** : le dessin domine l'écran. Barre essentielle : annuler/rétablir, Publier, stylo, gomme, six couleurs, et une ligne de consigne « Case N sur 4 · thème de l'histoire » + rôle de la case (pour une ancienne histoire, c'est son thème d'origine qui s'affiche); quand on continue une case, « Revoir l'histoire » ouvre les cases précédentes en feuille, puis « Retour au dessin » retrouve le canevas intact. Une case 4 ne termine que sa branche : les autres versions restent continuables. Pot, sélections, déplacement, main, tailles, motifs et « stylet seulement » sont dans le tiroir « Outils », qui recouvre le bas de la zone de dessin au lieu de la rétrécir (le canevas garde sa taille) et se referme au premier trait de stylo ou de gomme. Paysage : console en colonne à droite (216 à 300 px selon l'écran), tiroir intégré à la colonne.
- Aucune fausse donnée : l'accueil n'affiche que les vraies créations de la salle, avec un état vide sinon.

## Parcours (phase C)

- **Accueil** : thème actif et délai avant le prochain (heure du serveur), Jouer, Commencer une histoire, bandeau « Quelqu'un a imaginé une suite à l'un de tes dessins ! » (suites arrivées depuis ta dernière visite à Mes dessins, mémorisées sur l'appareil), derniers dessins de la salle. Quand la salle de la semaine est vide, quelques dessins publics de parties précédentes sont affichés comme « Archives », à lire seulement : ils ne sont jamais ajoutés à la salle ni à la partie courante.
- **Lire** (`#/read`) : histoires terminées et en cours de la semaine, accès à toutes les histoires de la semaine et aux semaines précédentes (archives).
- **Mes dessins** (`#/mine`) : tes cases avec ce qui leur est arrivé (« Personne n'a encore continué ton dessin. », « 2 personnes ont imaginé une suite ! », « Une histoire complète est née de ton dessin ! »), badge « Nouveau », accès aux suites et à l'histoire complète, invitation à continuer. Ni score ni classement. Les notifications push existantes ouvrent la case concernée.
- **Case** : le fil jusqu'ici, « Dessiner la suite », « Toutes les suites » (vue arbre secondaire), suites imaginées par les autres, signaler.
- **Éditeur** : le dessin est soit une case 1, soit la suite d'une case. « Publier ma case » affiche une vérification (thème, position dans l'histoire, rappel de la dernière case), envoie l'aperçu PNG dans Supabase Storage, puis appelle `publish_contribution`; le serveur applique toutes les règles.
- **Après la publication** (`#/published/<case>`) : la nouvelle case apparaît à la suite des précédentes (révélation animée, sans score) avec le message adapté (« Ta première case est publiée ! », « Ta suite est publiée ! », « Votre histoire est terminée ! ») et une note qui renvoie vers « Mes dessins ». Actions : cases 1 à 3 « Continuer une autre histoire » et « Voir mon histoire »; case 4 « Lire notre histoire » et « Jouer à nouveau ». Si aucune histoire n'est continuable, « Commencer une nouvelle histoire » est proposé à la place (jamais de liste vide).
- **Histoire** : feuilletage au doigt case par case (mode par défaut sur mobile), planche 2×2, « Voir une autre suite » / « Et si l'histoire continuait autrement ? » sous chaque case, « Revenir au début », « Inventer une autre fin » (si la case précédente peut être continuée), auteurs, export PNG, partage.
- **Toutes les suites** (arbre, vue secondaire) et **Semaines précédentes** (histoires terminées, histoires inachevées toujours continuables).

Aucun brouillon : le dessin n'est conservé nulle part avant sa publication.


## Éditeur (phase B)

Bouton « Dessiner ». Une seule image 320×240 (jamais suréchantillonnée, affichée sans lissage), palette de 6 couleurs; pas de calques ni d'animation.

- **Outils** : stylo (6 tailles, 6 textures, pression), gomme (5 tailles), pot de peinture avec motifs, sélection rectangulaire et libre, déplacement, retournement, rotation, copier/couper/coller/supprimer, annuler/rétablir (100 pas, perdus au rechargement). Aucune sauvegarde ni brouillon : on dessine, on publie ou on abandonne.
- **Vue** : zoom 1× à 10× (pincement, molette, boutons), déplacement (outil Main, deux doigts, Espace+glisser), rejet de la paume pendant l'usage du stylet.
- **Publication** : l'aperçu PNG est envoyé dans Supabase Storage (seul fichier conservé). Aucun export de fichier côté éditeur. La planche PNG d'un yonkoma complet se fait depuis la page Histoire.
- **Raccourcis (ordinateur)** : B stylo, E gomme, G pot, M rectangle, L lasso, V déplacer, H main, Ctrl/Cmd+Z/Y, Ctrl/Cmd+C/X/V, Entrée valide, Échap annule, +/-/0 zoom.

**Confort stylet et mobile** : réglage « Stylet seulement » (le doigt déplace la vue), blocage du zoom de page sur Safari iOS, animations d'interface désactivées si le système réduit les animations.

## Règles du jeu

- Le jeu est ouvert 7 jours sur 7. Aucune règle ne dépend du jour de la semaine.
- Chaque lundi 00:00 (Europe/Paris), le thème de la semaine devient actif, sans intervention de l'administrateur. Les anciennes histoires restent consultables et leurs branches inachevées restent continuables, avec leur thème d'origine.
- Une case 1 se crée quand on veut, dans le thème actif. Chaque continuation porte la profondeur de son parent + 1; la case 4 termine la branche.
- Aucune limite quotidienne. On ne peut jamais continuer directement sa propre case (on peut réintervenir si le parent est à quelqu'un d'autre : Alice → Bob → Alice → Chloé). Seul un débit maximal anti-abus s'applique (60 publications/heure par défaut).
- Salles de 99 participants maximum, sans emprunt de dessins entre salles. Une salle vide propose directement de créer une case 1.
- Les brouillons privés ne sont jamais proposés à la continuation.
- Événements de notification : `new_theme`, `continuation`, `new_branch`, `story_completed` (voir la section Notifications).

## Notifications (Web Push)

Désactivées par défaut : Réglages > Notifications demande le consentement, propose deux préférences séparées (rappel du nouveau thème, activité sociale) et une période de silence (heure de Paris). Le désabonnement est immédiat. Aucun rappel quotidien.

- **Événements** : créés par `publish_contribution` (continuation de ton dessin, nouvelle branche dans une histoire où tu as participé, histoire terminée) et par `enqueue_new_theme` (lundi à partir de 08:00 heure de Paris, une fois par semaine).
- **Regroupement** : les événements d'un même groupe qui attendent (2 minutes) n'en font qu'un avec un compteur : 40 suites = « 40 personnes ont continué ton dessin ».
- **Clic** : ouvre la case ou l'histoire exacte (fenêtre déjà ouverte réutilisée). Seuls des chemins internes sont acceptés.
- **Prise en charge** : jamais de simulation. Sur iPhone et iPad, le Web Push exige l'application installée sur l'écran d'accueil ; le service worker n'est actif qu'en version construite (`npm run build` puis `npm run preview`, ou site déployé en HTTPS).

Mise en service côté serveur (une fois) :

1. `npm run push:setup` (clés VAPID, secret, fichiers locaux ignorés par git), puis corriger `VAPID_SUBJECT` dans `.env.local` et relancer la commande.
2. `npx supabase login` puis `npx supabase link --project-ref <ref>`.
3. `npx supabase secrets set --env-file supabase/.env.functions`.
4. `npx supabase functions deploy dispatch --no-verify-jwt`.
5. Tableau de bord > Database > Extensions : activer `pg_cron` et `pg_net`.
6. Éditeur SQL : appliquer `0004_notifications.sql`, `0005_png_only.sql`, `0006_discovery.sql` puis `0007_progress.sql`, puis le contenu de `supabase/schedule.local.sql` (planifie l'envoi chaque minute, seulement s'il y a quelque chose à envoyer, et l'annonce du lundi).
7. Rebuilder et déployer l'application avec `VITE_VAPID_PUBLIC_KEY`.

## Calendrier et tests

L'heure fait autorité côté serveur (`current_game()`, Europe/Paris). Le calendrier accéléré et le seed manuel existent dans le domaine (`src/domain/calendar.ts`, `GameEngine`) et sont testés, mais ne sont plus branchés sur l'interface : un test accéléré sur serveur reste à prévoir.

## État d'avancement

| Phase | État |
| --- | --- |
| A — PWA installable, thèmes par seed, calendrier hebdomadaire continu, salles/embranchements (domaine), schéma SQL | Fait; schéma vérifié dans PGlite |
| B — Éditeur | Fait (voir ci-dessus); non testé sur iPad/Apple Pencil/Android réels |
| C — Partie complète (publication, lecture, archives) | Fait et vérifié contre le projet Supabase réel (13 contrôles API + publication depuis l'éditeur + lecture); non testé : accès réellement concurrents, iOS/Android réels |
| D — Web Push | SQL vérifié dans PGlite (29 contrôles), chiffrement Web Push vérifié par déchiffrement, envoi testé avec des faux services; **fonction `dispatch` non déployée ni testée sous Deno, aucune notification réellement reçue sur iOS/Android** |
| E — Finitions | Outils (retournement, rotation), réglage stylet, arbre amélioré, animations. Import KWZ, calques et animation retirés de l'éditeur. Optimisations Apple Pencil/Android non testées sur matériel |

Test manuel restant pour la phase A : installation sur iPhone/Android réels.

## Déploiement sur GitHub Pages

Le workflow `.github/workflows/deploy.yml` construit et publie l'application à chaque push sur `main` (typecheck et tests d'abord).

1. Dépôt GitHub > Settings > Pages > Source : **GitHub Actions**.
2. Settings > Secrets and variables > Actions > **Variables** : `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_VAPID_PUBLIC_KEY` (valeurs publiques par conception; ne jamais publier la clé `service_role` ni la clé privée VAPID).
3. Supabase > Authentication > URL Configuration : ajouter `https://<compte>.github.io/<dépôt>/` aux URL autorisées (liens e-mail).
4. Le site est servi sous `/<dépôt>/` (variable de build `VITE_BASE`); avec un domaine personnalisé, mettre `VITE_BASE` à `/` dans le workflow.

Le routeur par hash évite toute configuration de redirection côté serveur; les notifications push et le service worker fonctionnent en HTTPS, ce que fournit GitHub Pages.
