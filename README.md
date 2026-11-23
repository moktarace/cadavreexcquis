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
npm run db:themes  # imprime l'import SQL de supabase/themes.json (--seed: régénère 0012_theme_bank_seed.sql)
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
3. `0003_themes.sql` : historique (anciens thèmes générés et parties 2026–2030). Ne plus le régénérer : la banque de thèmes (0011, 0012) prend le relais pour les semaines à venir.
4. `0004_notifications.sql` : file d'attente des notifications, regroupement, heures de silence, annonce du nouveau thème, réservation atomique pour l'envoi; remplace `publish_contribution` pour produire les événements.
5. `0005_png_only.sql` : supprime le projet JSON (politiques du bucket `projects`, type d'asset, colonne `format_version`).
6. `0006_discovery.sql` : `archive_weeks()` et `archive_highlights()` (lecture des archives sans limite arbitraire, jamais la partie courante ni une partie privée), ordre total de `contribution_subtree`.
7. `0007_progress.sql` : `contribution_progress()`, ce que les autres ont fait de tes dessins (suites, histoire terminée), pour « Mes dessins ».
8. `0008_replies.sql` : table `reply_reads` (état « lu » par joueur et par réponse, RLS : on ne lit et n'écrit que le sien, jamais de modification) et `unread_replies()`. Les réponses déjà publiées au moment de la migration sont considérées comme connues.
10. `0010_rewards.sql` : récompenses collectives (voir « Récompenses et tampons ») : `story_credits`, `reward_events`, `sticker_unlocks`, `sticker_rules`, `reward_config`, `credit_story()` branchée sur `publish_contribution`, rattachement des histoires déjà terminées (`backfill_story_credits()`, exécuté par la migration), `my_progress()`, `my_reward_events()`, `mark_reward_events_seen()`, `admin_revoke_story()` et `sync_reward_rules()`.
11. `0011_theme_bank.sql` : banque de thèmes (voir « Banque de thèmes »), tirage « barillet » des semaines à venir, fonctions `admin_theme_*`; supprime l'ancien secours `ensure_weekly_game`.
12. `0012_theme_bank_seed.sql` : **généré** depuis `supabase/themes.json` (`npm run db:themes -- --seed`), premier chargement de la banque.

Mise en place sur un projet Supabase :

1. Authentication > Sign In / Providers : activer **Allow anonymous sign-ins**.
2. Appliquer les migrations : soit coller les trois fichiers dans l'éditeur SQL du tableau de bord, dans l'ordre; soit ajouter `SUPABASE_DB_URL` dans `.env.local` (Project Settings > Database > Connection string) puis `npm run db:apply`.

`npm run db:check` exécute ces migrations dans PGlite avec des rôles et une RLS simulés (102 vérifications : profil automatique, partie courante, auto-continuation refusée, case 4 finale, projet réutilisé ou d'autrui refusé, insertion directe refusée, projet publié figé, signalements, notifications, archives, pagination déterministe, états de lecture des réponses). Cela ne remplace pas un test sur la vraie base; les accès réellement concurrents et le stockage ne sont pas testés.
9. `0009_admin_moderation_expiry.sql` : administrateurs (`admins`, `is_admin()`), fenêtre de vie des thèmes (`starts_at`, `expires_at`, `purged_at`), dessins masqués (`hidden_kind`), signalements (`report_contribution`, blocage des signaleurs), fonctions `admin_*`, nettoyage manuel avec aperçu, file de suppression des fichiers (`storage_deletions`), journal (`purge_log`), purge automatique (`purge_expired_games`, **désarmée par défaut**) et blocage des publications sur un thème expiré (`GAME_EXPIRED`).


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

- **Accueil** : thème actif et délai avant le prochain (heure du serveur), Jouer, Commencer une histoire, bandeau « Quelqu'un a continué ton dessin ! » quand des réponses attendent d'être découvertes, derniers dessins de la salle. Quand la salle de la semaine est vide, quelques dessins publics de parties précédentes sont affichés comme « Archives », à lire seulement : ils ne sont jamais ajoutés à la salle ni à la partie courante.
- **Lire** (`#/read`) : histoires terminées et en cours de la semaine, accès à toutes les histoires de la semaine et aux semaines précédentes (archives).
- **Mes dessins** (`#/mine`) : « À découvrir » (seulement s'il y a des réponses non ouvertes) montre pour chaque réponse directe à l'une de tes cases ta case, une flèche et la case dessinée par l'autre joueur (trois joueurs = trois paires). Toucher une paire ouvre `#/reply/<id>` : « Voici ce que quelqu'un d'autre a fait de ton dessin ! », les deux images, « Lire l'histoire depuis le début », les autres réponses (ou fins) à la même case, les fins de l'histoire, retour à Mes dessins. « Tous mes dessins » garde toutes tes cases, une fois chacune, avec « En attente d'une suite », « 1 suite », « 3 suites » ou « Dernière case ». États vides : « Tu n'as pas encore dessiné ! », « Tes dessins attendent que d'autres joueurs inventent la suite ! », « Tu as découvert toutes les nouvelles suites ! ». Ni score, ni like, ni commentaire.
- **Pastille** : un point sur « Mes dessins » dans le dock tant qu'une réponse n'a pas été ouverte (pas de chiffre, aucune notification push ni permission). Est une nouveauté la continuation **directe**, par un autre joueur, d'une de tes cases (y compris une case 4 pour l'auteur de la case 3); une suite plus lointaine notifie l'auteur de la case parente, pas celui de la case 1. L'état « lu » est enregistré sur le serveur (`reply_reads`) quand la réponse est réellement ouverte (écran de réponse, fiche de la case ou lien d'une notification push), pas en ouvrant Mes dessins : il suit le compte sur tous ses appareils et survit au rechargement. L'état est relu au lancement, au retour sur l'application, à la reconnexion et toutes les 45 s; une erreur réseau conserve les nouveautés connues (dernier état mémorisé sur l'appareil pour la pastille) et une ouverture non enregistrée est renvoyée plus tard. La table `notifications` existante est la file d'attente du Web Push (abonnés seulement, regroupée, vidée à l'envoi) : elle ne sert pas d'état de lecture.
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
- **Tampons** (Outils > Tampons) : six tampons de départ (cœur, larme, étoile, couronne, petit impact, éclair) et huit à débloquer (voir « Récompenses et tampons »). Un tampon se choisit (les verrouillés disent comment l'obtenir), apparaît en aperçu au centre, se déplace au doigt, à la souris ou à l'Apple Pencil (un appui à côté le fait sauter sous le stylet), se redimensionne par multiples entiers (×1 à ×4, sans flou) puis se valide avec OK ou s'abandonne avec Annuler. Il est ensuite fusionné dans l'image comme n'importe quels pixels (palette de six couleurs, aucun calque conservé), compte pour une entrée d'Annuler/Rétablir, et la limite est de trois tampons par case (`maxStampsPerCase`). Le blanc d'un tampon peint, le transparent laisse le dessin intact.
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
6. Éditeur SQL : appliquer `0004_notifications.sql`, `0005_png_only.sql`, `0006_discovery.sql`, `0007_progress.sql`, `0008_replies.sql` puis (voir la section suivante) `0009_admin_moderation_expiry.sql`, puis le contenu de `supabase/schedule.local.sql` (planifie l'envoi chaque minute, seulement s'il y a quelque chose à envoyer, et l'annonce du lundi).
7. Rebuilder et déployer l'application avec `VITE_VAPID_PUBLIC_KEY`.

## Administration, modération et expiration

### Conservation des créations

Un thème est actif sa première semaine (lundi 00:00), reste consultable et continuable la semaine suivante comme ancien thème, puis **toutes** ses contributions disparaissent le deuxième lundi à 00:00 (Europe/Paris, calculé en dates civiles : exact autour des changements d'heure), quelle que soit leur date de publication. Exemple : thème A actif le lundi 16 novembre 2026, thème B le 23, suppression du thème A le 30. Une continuation publiée le dimanche de la deuxième semaine disparaît donc avec le reste du thème. Les parties privées ou de test n'expirent jamais d'elles-mêmes.

- La lecture s'arrête à l'échéance exacte (la vue `contribution_cards` filtre les thèmes expirés) et `publish_contribution` / `join_game` refusent tout thème expiré, même depuis un ancien onglet (`GAME_EXPIRED`) ; l'éditeur propose alors de rejoindre le thème de la semaine, sans jamais publier dans le mauvais thème. La purge physique, quelques minutes plus tard, supprime contributions, salles, états de lecture, signalements, notifications et brouillons techniques liés, puis met les fichiers du Storage en file de suppression.
- Les dates sont affichées discrètement : « Les dessins de ce thème disparaîtront le lundi … » sur la carte du thème, en Lire, sur la page d'une histoire ou d'une semaine, et dans Mes dessins uniquement pendant la deuxième semaine d'un thème (avec un rappel pour exporter les BD terminées en PNG depuis leur page).
- Concurrence : `publish_contribution` verrouille la partie en lecture puis la case parente ; la purge verrouille la partie en écriture avant de supprimer. Une publication acceptée juste avant l'échéance est supprimée avec le thème, une publication qui arrive après est refusée.
- La purge de chaque thème est une transaction à part (tout ou rien), idempotente et journalisée (`purge_log`) ; une panne laisse le thème intact et il est repris au passage suivant. La file `storage_deletions` ne marque un fichier supprimé qu'après confirmation du Storage et le reprend en cas d'échec (10 essais). Un balayage quotidien met aussi en file les aperçus de plus d'un jour que plus aucune ligne ne référence.

### Mise en service (rien n'est supprimé avant l'étape 6)

1. Sauvegarder la base (export Supabase) : la migration masque immédiatement à la lecture les thèmes dont l'échéance est passée (par exemple tout ce qui date de plus de deux semaines).
2. Appliquer `0009_admin_moderation_expiry.sql` (`npm run db:apply` ou éditeur SQL). Elle ne supprime rien et la purge est désarmée.
3. Déployer la fonction de suppression des fichiers : `npx supabase functions deploy purge --no-verify-jwt` (elle réutilise le secret `DISPATCH_SECRET` et vérifie elle-même le secret ou le jeton d'un administrateur).
4. Se déclarer administrateur : ouvrir Réglages, copier l'« Identifiant du compte », puis dans l'éditeur SQL `insert into public.admins (user_id) values ('<identifiant>');`. Rattacher une adresse e-mail au compte (Réglages) pour ne pas perdre l'accès. Personne n'est administrateur par défaut.
5. Planifier (pg_cron et pg_net déjà activés) : `select public.schedule_expiry('https://<ref>.supabase.co/functions/v1/purge', '<DISPATCH_SECRET>');` (purge toutes les 5 minutes, balayage des orphelins à 03:17, envoi de la file de fichiers).
6. Vérifier dans `/admin` > Échéances ce qui serait supprimé, puis **seulement alors** armer la suppression automatique : `select public.enable_expiry_purge();` (et `select public.enable_expiry_purge(false);` pour la désarmer).

### Administration (`#/admin`)

Réservée aux comptes de la table `admins`. Chaque fonction `admin_*` revérifie `is_admin()` côté serveur, la table `admins` n'a aucune politique d'accès, et le navigateur n'a jamais de clé `service_role` : la suppression des fichiers passe par l'Edge Function `purge`. Une condition React seule ne protège rien ; elle n'affiche que « Page introuvable » aux autres.

- **Dessins** : liste paginée avec miniatures, filtres par thème/semaine, auteur (« Mes contributions »), statut (visible, signalé, masqué, retiré, emplacement neutre) et recherche (identifiant, auteur, thème) ; masquer et rétablir un ou plusieurs dessins.
- **Signalements** : à examiner, retraits confirmés, écartés, abusifs, historique complet ; confirmer le retrait, rétablir, écarter, marquer abusif ou bloquer le signaleur.
- **Nettoyage** : sélection précise, puis aperçu chiffré (dessins supprimés, emplacements neutres conservés, suites d'autres auteurs préservées, histoires, fichiers, signalements, états de lecture, notifications). « Seulement ces dessins » remplace une case qui a encore des suites par un emplacement neutre (image supprimée, structure conservée) et supprime vraiment les autres ; « Avec toutes leurs suites » est le seul mode qui supprime aussi les dessins des autres participants. La suppression exige de taper SUPPRIMER et que l'aperçu soit encore exact (`PLAN_CHANGED` sinon). Rien n'est jamais supprimé parce qu'il appartient à un thème ou à une histoire que vous avez commencée.
- **Échéances** : prochaines suppressions par thème, état armé ou non, fichiers en attente, journal des opérations.
- **Banque de thèmes** : voir ci-dessous.

### Banque de thèmes

Les thèmes ne sont plus générés (plus de combinaison métier + adjectif, personnage, lieu). Ils viennent d'une **banque** de titres courts et ouverts, dans l’esprit des cartons de match d'improvisation, stockée en base (`themes` avec `in_bank`) et initialisée depuis `supabase/themes.json` (212 titres **originaux**, ni copiés d'une banque existante ni présentés comme des thèmes authentiquement joués : chaque thème porte sa provenance, `original`, `imported` ou `referee`). L'objectif est de pouvoir la compléter jusqu'à ≈ 520 titres (dix ans, un par semaine).

**Tirage « barillet ».** Chaque lundi 00:00 (Paris), la partie de la semaine devient active, comme avant : un seul thème partagé, aucune IA, aucun coût. Les semaines à venir (≈ dix ans, `ensure_schedule_weeks`) reçoivent leur thème par `redraw_theme_schedule()` : on retient, parmi les thèmes les moins sortis, celui dont l'empreinte `md5('barillet/v1:' || titre || semaine)` est la plus petite. C'est déterministe, et aucun thème ne revient avant que toute la banque soit passée (puis un nouveau tour commence). Le carton de la semaine suivante (qui commence dans moins de 7 jours) et toutes les semaines commencées sont **figés** : ajouter, corriger, retirer ou importer des thèmes ne modifie jamais un thème déjà attribué, seulement les semaines encore lointaines. Un thème déjà utilisé (ou d'une partie privée) est immuable et ne peut être ni modifié ni retiré. Les anciennes histoires gardent leur thème d'origine jusqu'à leur suppression (2ᵉ lundi suivant leur début).

**Mise en service.** Appliquer 0011 puis 0012 (`npm run db:apply`) ne change pas le thème actif : le nouveau système prend le relais au prochain lundi. Les joueurs ne peuvent lire que les thèmes des semaines commencées : les prochains cartons restent secrets (réservés à l'administration).

**Gérer la banque** sans redéploiement : onglet « Banque de thèmes » de `#/admin` (mêmes droits que le reste de l'administration, revérifiés côté serveur) : consulter tous les thèmes avec leur statut (libre, programmé, utilisé), chercher, ajouter, corriger ou retirer un thème inutilisé, voir les prochains cartons et importer une liste (un titre par ligne ou JSON, avec détection des doublons exacts — accents, majuscules, ponctuation et articles ignorés — et des titres trop proches avant confirmation). Pour de vrais cartons de feuilles d'arbitre, choisir la provenance « Feuille de match (arbitre) ». En ligne de commande : ajouter les titres dans `supabase/themes.json` puis `npm run db:themes` et coller le SQL affiché dans l'éditeur SQL (les doublons sont ignorés).

### Laboratoire : Télécrayon (prototype)

Page expérimentale `#/lab/telecrayon` (URL directe, aucun lien dans le jeu, chargée à part) pour tester un dessin à deux pouces sur smartphone : le pouce gauche déplace un curseur sur un pavé relatif (accélération légère, profils Précis et Rapide, réglables dans le panneau de mesures), le pouce droit maintient TRACER (appui bref = un point; glisser vers la zone d'annulation puis relâcher abandonne le trait). Elle réutilise `EditorSession` (mêmes couleurs, même pinceau, annuler/rétablir) mais ne publie rien, n'appelle pas Supabase et ne garde rien. Le mode « Direct » permet de comparer avec le doigt sur la toile. Sur ordinateur : glisser à la souris sur le pavé en maintenant Espace tient lieu de TRACER. Logique et tests : `src/lab/`.

### Signalements

Publication immédiate, sans approbation. « Signaler ce dessin » (fiche d'une case et lecture d'une histoire) propose cinq motifs et une précision facultative. Le premier signalement valide masque le dessin au public (« Dessin temporairement masqué ») : l'image n'est plus exposée par la vue, les cases des autres auteurs et la structure sont conservées, la case ne peut plus être continuée directement (`PARENT_HIDDEN`) et rien n'est détruit. Interdit : signaler son propre dessin ou le même dessin deux fois ; limite de 10 signalements par heure et par joueur ; les signalements d'un compte bloqué sont enregistrés sans effet. Un dessin rétabli n'est pas remasqué par d'anciens signalements : trois nouveaux signalements ouverts, postérieurs au rétablissement, sont nécessaires. Limites connues : le bucket `previews` est public, donc un fichier masqué reste lisible par quelqu'un qui connaît déjà son URL jusqu'à sa suppression définitive ; des comptes anonymes en nombre peuvent contourner la limite par joueur (d'où le blocage manuel).

## Récompenses et tampons

Deux plaisirs sont récompensés, sans monnaie, XP, classement ni série quotidienne :

- **Histoires collectives terminées** : quand la case 4 d'un chemin est publiée, chaque auteur distinct du chemin (cases 1 à 4) reçoit +1, une seule fois même s'il a dessiné deux cases. Chaque case 4 est une histoire distincte, donc un embranchement qui aboutit ailleurs compte à part. Une branche inachevée ne rapporte rien.
- **Histoires inspirées** : l'auteur de la case 1 reçoit +1 pour chaque histoire terminée qui en descend (compteur total par joueur, et par première case via `story_credits.root_id`). Les deux compteurs sont indépendants : l'auteur d'une case 1 profite des deux.

Tout est calculé par le serveur dans la transaction de `publish_contribution` (`credit_story`), idempotent (clé primaire `(case 4, joueur, nature)`), sûr en cas de publications simultanées, et sans effet si le chemin contient une case masquée ou retirée par la modération ; un dessin rétabli ensuite déclenche le crédit. L'administration peut retirer les récompenses d'une histoire abusive (`admin_revoke_story`), qui ne sera plus jamais recréditée ; les tampons déjà débloqués restent acquis. Limite connue : des comptes anonymes en nombre pourraient s'envoyer des histoires, comme pour les signalements ; seul le débit maximal de publication s'applique.

**Les récompenses survivent à l'expiration.** Les tables de récompenses ne référencent pas les contributions (aucune clé étrangère) : après la suppression d'un thème, les compteurs, les tampons et l'historique minimal (identifiants) restent acquis. Seules les nouveautés qui renvoyaient aux dessins supprimés sont marquées « disparues » (déclencheur sur la suppression des contributions) et n'ouvrent plus aucune page ; les notifications push associées sont déjà nettoyées par la purge.

**Tampons.** Six dès le départ ; huit se débloquent automatiquement :

| Histoires terminées | Tampon | Histoires inspirées | Tampon |
|---|---|---|---|
| 1 | Explosion | 1 | Moustache |
| 3 | Effet de vitesse | 3 | Lunettes |
| 5 | Nuage de fumée | 5 | Chapeau extravagant |
| 10 | Fantôme | 10 | Masque mystérieux |

Plusieurs seuils atteints d'un coup se présentent dans une seule fenêtre « Nouveau tampon débloqué ! ». Les paliers « Ton dessin a inspiré N histoires différentes ! » sont 3, 5 et 10 pour une même case 1.

**Configuration centralisée** : `src/domain/stickers.ts` (seuils, paliers, limite et tailles de tampon, pixel art 16 × 16 en six couleurs). Le serveur applique ses propres copies (`sticker_rules`, `reward_config`) : après avoir modifié un seuil, lancer `npm run db:stickers` et exécuter dans l'éditeur SQL la commande affichée (`sync_reward_rules`, qui réévalue tous les joueurs et ne retire jamais un tampon acquis). Un test vérifie que la configuration et la migration restent identiques.

**Présentation.** Auteur de la case 4 : l'écran de publication révèle les quatre cases dans l'ordre (la dernière mise en valeur), avec confettis pixel art, « Votre histoire est terminée ! », « Une nouvelle BD à plusieurs est née ! », les auteurs sans doublon, « +1 histoire collective terminée » et « Passer l'animation ». Autres auteurs : « Mes dessins » > « À fêter » regroupe, sans enchaîner d'animations, « Une histoire à laquelle tu as participé est terminée ! » (ouvre `#/finished/<case 4>`), les paliers d'inspiration avec les miniatures des fins qui existent encore, et les tampons débloqués (fenêtre ouverte automatiquement une fois par session, jamais dans l'éditeur). Une pastille s'ajoute à celle des réponses. « Ma collection » (compteurs, tampons verrouillés avec leur condition) et « Mes histoires terminées » restent discrets. Aucune notification push supplémentaire ; pas de son ; `prefers-reduced-motion` supprime confettis et révélations.

**Mise en service** (aucune opération destructive) : appliquer `0010_rewards.sql` (`npm run db:apply`). La migration rattache les histoires déjà terminées sans double comptage (relançable avec `select public.backfill_story_credits();`) et sans nouveauté « histoire terminée » ; les tampons ainsi débloqués sont annoncés dans « Mes dessins ». Aucune tâche planifiée ni fonction Edge nouvelle.

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
