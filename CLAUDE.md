# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for ONVIF IP cameras: a Node.js
service (Node 22+, ESM, no build step) that runs in its own sandboxed Docker
container and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency (the ONVIF client is written here, and the image
adds the `ffmpeg` Alpine package). It started from the official JavaScript
template.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/devices.test.js          # one file
node --test --test-name-pattern "plug"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/app.js), graceful shutdown
src/app.js                        registers every SDK handler, waits for the first start
src/hub.js                        cameras, devices, images, PTZ queue + watchdog, event loops, trigger
src/devices.js                    Gladys devices and features, names, preset numbers
src/discovery.js                  WS-Discovery probe (mediated scan) and its answers
src/image.js                      ffmpeg: fit an image under 150 KB, grab an RTSP frame
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/scenes.js                     scene actions goto_preset, move_camera
src/widgets.js                    dashboard widget `camera` (+ its images)
src/texts.js                      connection status, search report (four languages)
src/store.js                      /data/onvif-state.json (cameras known, no password)
src/onvif/xml.js                  XML reader by local names (no DTD), serializer
src/onvif/http.js, digest.js      HTTP with time/size bounds, Digest and Basic
src/onvif/soap.js                 SOAP 1.2, WS-Security digest, faults, typed errors
src/onvif/camera.js               device, media, PTZ, event operations
src/onvif/events.js               event topics → detection kinds
gladys-assistant-integration.json manifest
docs/{en,fr,de,es}.md             user documentation, re-hosted by Gladys (same sections)
test/helpers/fakeCamera.js        simulated cameras (happytime recording, hikvision, tapo)
test/helpers/world.js             fake Gladys + fake cameras + temporary /data
test/fixtures/onvif/              recorded SOAP answers, real event payloads
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** exists in English, French, German and Spanish:
  action messages, manifest texts, widget texts, feature names, and
  `docs/en.md`, `docs/fr.md`, `docs/de.md`, `docs/es.md`, kept in sync
  (`test/i18n.test.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.

---

# Notes du mainteneur (guim31)

Ce qui suit complète les règles du template ci-dessus. Ce sont des faits vérifiés dans le code du
cœur Gladys ou payés sur les intégrations déjà publiées par guim31. Ils ne se lisent pas dans le
code de ce dépôt. Compléter ce fichier quand un nouveau piège est découvert.

## Travailler sur ce dépôt

- Mêmes étapes que la CI, dans le même ordre : `npm ci`, `npm run format:check`, `npm run lint`,
  `npm test`. Prettier contrôle **aussi le Markdown** : lancer `npm run format` après avoir
  modifié ce fichier, le README ou la documentation, sinon la CI tombe.
- Une session de code n'a **ni instance Gladys ni appareil réel**. La suite de tests, le lint et
  le validateur du store sont les seules vérifications possibles : le test réel se fait ailleurs.
  Le dire, plutôt que de conclure que « ça marche ».
- **Tout le code de démonstration du template disparaît** : station météo, prise, lampe, caméra,
  capteur de mouvement, `src/weather.js`, leurs tests, leurs entrées du manifeste et de la
  documentation. Il ne reste que ce que l'intégration fait vraiment.
- **Publier n'est jamais le travail d'une session de code** : ni Release, ni tag, ni topic, ni
  version modifiée à la main. L'orchestrateur s'en charge une fois la PR fusionnée. Les workflows
  sont ceux du template : ne pas les modifier.
- Le dépôt est **public** : aucun secret, aucune adresse ni détail d'infrastructure privée, ni
  ici, ni dans les tests, ni dans les captures.

## Pièges du cœur Gladys

**Appareils et fonctionnalités**

- **Polling** : le planificateur n'interroge un appareil que si `should_poll: true` **et**
  `poll_frequency` vaut une valeur de la liste fixe, **en millisecondes** (1000, 2000, 10000,
  15000, 30000, 60000). Le template publie `poll_frequency: 300` sans `should_poll` : c'est faux,
  le cœur répond 400 à la découverte. Pour une cadence hors liste, publier `should_poll: false` et
  pousser les états depuis le conteneur, en gardant un `onPoll` de repli.
- **`min` et `max` sont NOT NULL** dans `t_device_feature`, y compris pour `text/text` : sans eux,
  « Ajouter à Gladys » échoue en HTTP 422. Mettre 0/0, comme Zigbee2MQTT.
- Un état publié sur une fonctionnalité **pas encore ajoutée** dans Gladys reçoit un 200 puis est
  jeté (simple ligne de log) : republier les états dans `onDeviceCreated`.
- `level-sensor/decimal` n'existe pas côté serveur. `light-sensor/binary` n'a pas de libellé dans
  le front (pastille vide) : préférer `input/binary`. Un `text/text` reçoit `{ text }`, jamais
  vide, sinon l'état est ignoré.
- **Détecteur d'ouverture (`opening-sensor`) : 0 = ouvert, 1 = fermé** (`OPENING_SENSOR_STATE`), à
  l'inverse de l'intuition et des autres détecteurs (mouvement, fuite, fumée : 1 = détecté). Une
  porte ouverte publiée à 1 s'affiche « Fermé » et fausse scènes et historique. Le figer par un test.
- **Un `external_id` de fonctionnalité ne change jamais d'appareil** d'une version à l'autre. UniFi
  1.5.2 avait sorti les ports PoE dans un appareil dédié, la 1.6.0 les a remis dans la passerelle avec
  les mêmes identifiants : ceux qui avaient ajouté l'appareil dédié ne peuvent plus « Mettre à jour » la
  passerelle (409 `external_id must be unique`). Pour regrouper, garder l'appareil existant
  (`gladys.getDevices()`) ou changer d'identifiant.
- Les **noms de fonctionnalités sont figés à la création**. Et quand une fonctionnalité est seule
  de son type sur l'appareil, le tableau de bord affiche le libellé générique du type à la place
  du nom publié.
- **Aucune commande d'appareil ne permet un choix multiple** : un `text/select` n'a qu'un choix
  actif.
- Un changement de structure fait proposer « Mettre à jour » dans l'onglet Découverte
  (`structure_changed`). Un changement des seules `supported_options` ne le déclenche pas.
- **Jauge** : l'aiguille se place par `(value - min) / (max - min)` des bornes de la
  fonctionnalité. `gauge_min`/`gauge_max` ne pilotent que les couleurs, et le cœur n'applique
  jamais `min`/`max` en écriture : ce sont des bornes d'affichage. Une valeur signée exige des
  bornes symétriques.
- Le cœur plafonne à **300 états par minute** et réévalue les scènes à chaque état : ne publier
  que les changements.
- Une intégration `device` ne reçoit pas la langue de l'utilisateur, une action de scène non
  plus (un widget, si) : prévoir un champ de config `language` si des textes partent du
  conteneur. Le superviseur injecte `TZ`, le fuseau de Gladys. La sandbox est limitée à 256 Mo.

**Formulaires de configuration et actions**

- Les champs `number` sont rendus **sans `step`** : le navigateur n'accepte alors que `min + k`.
  Min et défaut **entiers** seulement ; une valeur décimale passe par un `select` ou par un
  `string` parsé (virgule acceptée).
- Un champ `secret` dans les `fields` d'une **action** est impossible à remplir, et une action
  n'applique **aucun `default`** tout en exigeant les champs `required` (422). Issues
  GladysAssistant/Gladys#3154 et #3155.

**Widgets, déclencheurs, actions de scène (SDK ≥ 0.14, Gladys ≥ 5.1)**

- **Cibler la dernière version publiée du cœur, pas `master`** : la spec de `master` décrit des
  fonctions non publiées. Les boutons de widget qui ouvrent un formulaire (#3168, commit 3feb2cf8)
  sont absents de la 5.1.4 mais **livrés dans la 5.2.0** (sortie le 12/10/2026) : `gladys_version`
  `>=5.2.0` si on s'en sert, ou un bouton direct en repli. Vérifier par `git tag --contains`.

- Un réglage de widget ne propose en liste que les **appareils** de l'intégration
  (`source: "devices"`, seule source dynamique).
- Budget du cœur : **8 composants par widget, dont 2 textes au plus**, appliqué **avant** la
  résolution des références ; un contenu amputé reste en cache jusqu'au TTL. Appeler
  `requestWidgetRefresh` à la création d'un appareil. `validateWidgetContent` est exporté pour les
  tests, mais ne vérifie pas que les `external_id` liés existent : les croiser avec `buildDevice`.
- Une ligne de `status` exige un `value` (nombre ou texte ≤ 40).
- Le cœur **jette un bouton dont la clé d'action est déjà prise** : clés numérotées.
- Le vocabulaire des widgets n'a ni liste ni curseur, **par choix** du cœur. Seul un bouton
  `device_feature` numérique a un état actif natif.
- **En mode sombre, le style `primary` d'un bouton de widget ne se voit pas** (#3153) : signaler
  un choix courant par l'icône (`check-circle`), jamais par le style.
- Dans une grille `card-list`, la `date` s'affiche **à la place** du sous-titre.
- `onWidgetAction` fait recharger le widget dès la résolution, alors que `requestWidgetRefresh`
  est plafonné à un appel toutes les 10 s. Un toast d'action est tronqué à 200 caractères.
- Le cœur met le contenu d'un widget en cache par (réglages, langue, unités) : pré-localiser
  d'après `language` est correct.
- Les filtres de scène ne font qu'égalité et appartenance : un seuil reste le travail d'un capteur.
- **Les clés de widgets, de déclencheurs et d'actions sont figées une fois publiées.**
- `gladys_version` `>=5.1.0` dès qu'il y a widgets, déclencheurs ou actions de scène.

## Store

- Validateur officiel, depuis la racine : `npx -y github:GladysAssistant/integration-store .`
  (schéma, `description` **100 caractères au plus par langue**, documentation de 300 caractères
  au moins, image Docker, cover de **150 Ko au plus**). Il demande Node ≥ 24 mais tourne sous
  Node 22 avec un avertissement.
- L'indexeur lit le manifeste de la **dernière release**, pas celui de `main` : une correction du
  manifeste (catégorie, description…) n'atteint le store qu'avec une release.
- L'indexeur rejette **en silence** : la raison n'apparaît que dans `rejected.json`, à côté de
  `https://integration-store-storage.gladysassistant.com/index.json`.
- **Image de base** : `FROM public.ecr.aws/docker/library/node:…` (miroir officiel ECR Public, même
  empreinte) et non `node:…` de Docker Hub, qui refuse en 429 les pulls anonymes des runners GitHub
  dès qu'il y a plusieurs builds à la fois. Un échec 429 dans le job « Docker build » n'est pas un bug
  du code. Même parade dans `.github/workflows/build.yml` (posée par l'orchestrateur, ne pas la
  retirer) : QEMU et BuildKit tirés de `mirror.gcr.io`.
- La règle `data/` du `.gitignore` du template (pour le volume `/data`) exclut aussi `src/data/` :
  l'ancrer en `/data/`, dans `.prettierignore` aussi.

### Langues (depuis le 11/10/2026)

Tout texte montré à l'utilisateur existe en **`en`, `fr`, `de` et `es`** : manifeste, contenu des widgets, messages,
noms de fonctionnalités. L'allemand **tutoie** (« du »), l'espagnol **vouvoie** (« usted ») : décision de Guilhem,
appliquée à ses 21 intégrations. `test/i18n.test.js` doit échouer sur une langue manquante, un texte vide ou trop
long, et sur un « Sie »/« Ihr… » de politesse en allemand. Le store exige `docs/en.md` et `docs/fr.md`
(`DOCS_LANGUAGES`) et publie aussi `docs/de.md` et `docs/es.md` quand ils existent
(`DOCS_OPTIONAL_LANGUAGES` d'integration-store) : écrire les quatre, avec les mêmes sections.

## Choix par défaut de Guilhem (12/10/2026)

- Langue par défaut des noms de fonctionnalités et des textes produits par le conteneur : **`fr`**.
- Fichier `LICENSE` Apache-2.0 (texte complet) à la racine.
- `transports` : `local` seul quand le cloud n'est qu'une option annexe.
- Docs `en`, `fr`, `de`, `es` avec les mêmes sections.
- Chauffe, ouverture, sécurité : ne rien rendre pilotable « comme un thermostat » ou par un assistant
  vocal quand une erreur serait dangereuse (leçon d'OctoPrint).

## Intégration ONVIF : API et pièges

- **Découverte** : WS-Discovery est en multicast (239.255.255.250:3702), le cœur 5.1+ n'émet qu'en
  **broadcast** (`udp-active-broadcast`, 255.255.255.255 et broadcast dirigé), charge **512 octets au
  plus**. La sonde part donc sans déclaration XML ni filtre `Types` (487 octets) et les réponses sont
  filtrées ici (`NetworkVideoTransmitter` ou scopes `onvif://`). Les piles gSOAP (et le serveur
  Happytime, vérifié en Docker) répondent au broadcast ; une caméra qui n'écoute que le groupe multicast
  ne répond pas : adresse saisie.
- **WS-Security** : `Created` en « Zulu » sans millisecondes (`2024-08-17T12:30:45Z`, Hikvision refuse
  `+00:00`), et décalé de l'horloge de la caméra (`GetSystemDateAndTime` sans authentification, refait à
  chaque contrôle de santé) : beaucoup de caméras refusent un jeton à plus de quelques minutes.
- **Verrouillage des comptes** : une caméra bloque un compte après quelques mauvais mots de passe. Un
  compte refusé par une adresse n'y est plus envoyé tant que l'empreinte des comptes ne change pas, sauf
  par l'action « Rechercher les caméras » (`force`).
- **Identité** : MAC de la **dernière** interface active (certaines caméras listent d'abord une interface
  factice au MAC identique sur tous les exemplaires, choix de Home Assistant), sinon numéro de série.
  Appareil = `<uid>_<jeton de source vidéo>`. Le serveur Happytime tire un MAC au hasard à chaque
  démarrage : ne pas s'en étonner en Docker.
- **Une autre caméra à la même adresse** (DHCP, remplacement) : le contrôle de santé ne vérifie pas
  l'identité, donc l'ancienne caméra passe « déplacée » (`displaced`) : ni image, ni commande, ni
  événements jusqu'à ce qu'une recherche la retrouve.
- **Adresses données par la caméra** (XAddr, snapshot, flux) : souvent fausses derrière un NAT ou mal
  réglées ; l'hôte est remplacé par celui qui a répondu, le port aussi quand c'était le port annoncé du
  service device (`fixUrl`). Le port RTSP est gardé.
- **Images** : le cœur borne la **chaîne** `image/jpg;base64,…` à 150 × 1024 caractères, soit ~112 Ko
  de JPEG ; ffmpeg réduit par paliers (1280 px puis moins). 12 images/min par caméra : espacement de
  5,1 s. Sans `GetSnapshotUri`, une image du flux RTSP du plus petit profil, identifiants dans l'URL
  (jamais journalisée, stderr de ffmpeg expurgé).
- **PTZ** : contrat `camera/move` (1-6, 0 = stop, jamais listé) et `camera/preset` (`supported_options`
  à valeurs entières). `ContinuousMove` borné par un chien de garde (`move_duration`, 1 s par défaut :
  un bouton de widget, une scène ou un appui dont le relâchement est perdu bougent de cette durée) ;
  `RelativeMove` si la caméra n'a pas de vitesse continue. Les commandes d'une source passent dans une
  file. Numéros de positions tirés du jeton seul (jeton numérique, sinon chiffres finaux, sinon hachage
  ≥ 100000) : stables sans stockage.
- **Événements** : PullPoint en long polling (`PullMessages` 20 s), `Renew` avant expiration, nouvel
  abonnement après erreur (60 s), `Unsubscribe` à l'arrêt ; certaines caméras exigent l'écho des
  `ReferenceParameters` en en-têtes WS-Addressing (Tapo, Axis). Hikvision écrit
  `2024-08-17-12:30:45Z`. Les notifications `Initialized` donnent l'état sans déclencher de scène. Les
  sujets suivent onvif-parsers ; `LineDetector/Crossed` est une impulsion (retour à 0 après 5 s).
- **`camera/enabled`** (mode privé, 5.2.0) n'est pas publié : le cœur considère la caméra toujours
  active. **`doorbell/ring`** n'existe qu'à partir de 5.2.0 : la sonnette reste un déclencheur.
- Tests Docker de référence : serveur ONVIF Happytime (binaire de la suite de tests d'agsh/onvif, usage
  non commercial, hors dépôt), MediaMTX pour le RTSP, `test/helpers/fakeCamera.js` servi en HTTP.
