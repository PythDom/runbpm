# RunBPM

Prépare une playlist dont le tempo (BPM) suit la **cadence de course idéale** tout au long d’un parcours,
en tenant compte du **dénivelé** et de l’**allure désirée**, puis accompagne la course d’un **métronome**.

- **À la maison** : RunBPM analyse votre musique (dossier local ou serveur **Navidrome**) : artiste, titre,
  **BPM mesuré** ; puis calcule la playlist adaptée au parcours.
- **Pendant la course**, au choix :
  - **Navidrome / Subsonic** : RunBPM lit lui-même les morceaux depuis votre serveur, **avec ajustement du
    tempo** (hauteur de voix préservée) et métronome superposable ;
  - **Spotify / Deezer** : la musique est jouée par l’application officielle ; RunBPM superpose un
    métronome au tempo du morceau en cours.

Tout est calculé dans l’application, aucun fichier audio n’est envoyé. RunBPM existe en **application
Android** (APK) et en page web ; une **base partagée** (petit serveur Python, par exemple sur
PythonAnywhere) garde les BPM mesurés et la sélection de chacun.

## Démarrage

```bash
npm install
npm run dev      # http://127.0.0.1:5173 (Spotify refuse « localhost »)
npm test         # tests unitaires (vitest)
npm run build    # version statique dans dist/ (déployable telle quelle, ex. GitHub Pages)
npm run server   # base partagée locale pour essais (http://127.0.0.1:8000), Python 3.8+
```

Essai rapide : « Essayer la boucle vallonnée d’exemple », puis « Bibliothèque de démo ».

## Installation : téléphone, base partagée, PC

```
 PC (navigateur)            PythonAnywhere                 Téléphone (APK)
 mesure les BPM   ──envoie──▶  base partagée  ◀──lit/coche──  prépare et joue la course
      │                    (BPM + sélections)                     │
      └──────────── lit la musique ── Navidrome ── lit la musique ┘
```

### 1. La base partagée sur PythonAnywhere (une fois)

Un seul fichier Python, sans dépendance : `server/runbpm_server.py` (SQLite).

1. Créez un compte gratuit sur [pythonanywhere.com](https://www.pythonanywhere.com) ; l’adresse sera
   `https://VOTRE_NOM.pythonanywhere.com`.
2. Ouvrez une console **Bash** (onglet *Consoles*) :
   ```bash
   git clone https://github.com/PythDom/runbpm.git
   python3 runbpm/server/runbpm_server.py adduser dom      # un utilisateur par personne
   python3 runbpm/server/runbpm_server.py adduser amie
   ```
   Chaque commande affiche un **code d’accès** (`dom:…`) : notez-le, il n’est affiché qu’une fois
   (`adduser` à nouveau en génère un autre ; `revoke` retire l’accès ; `users` liste les comptes).
3. Onglet *Web* › *Add a new web app* › *Manual configuration* › Python 3.x. Ouvrez le
   *WSGI configuration file* et remplacez son contenu par celui de `server/pythonanywhere_wsgi.py`
   (en remplaçant `VOTRE_NOM`). *Reload*.
4. Vérifiez : `https://VOTRE_NOM.pythonanywhere.com/api/health` répond `{"ok": true, …}`.

Compte gratuit : l’application web s’arrête au bout de 3 mois sans visite de l’onglet *Web* ; un clic
sur *Run until 3 months from today* la prolonge. Mise à jour : `cd runbpm && git pull`, puis *Reload*.
Sauvegarde : `python3 runbpm/server/runbpm_server.py export sauvegarde.json` (et `import` pour
restaurer). La base est dans `~/runbpm-data/runbpm.sqlite`.

### 2. Construire la base depuis le PC (une fois, puis pour les nouveaux morceaux)

La mesure des BPM lit un extrait de chaque morceau : c’est plus rapide sur le PC, à côté du serveur.

1. `npm install` puis `npm run dev`, et ouvrez http://127.0.0.1:5173.
2. Carte Streaming › **Navidrome** : adresse locale (`http://192.168.129.34:4533`), utilisateur, mot de passe.
3. Sous Navidrome, **Base partagée des BPM** : `https://VOTRE_NOM.pythonanywhere.com` et votre code.
4. **Importer la bibliothèque du serveur** : chaque morceau mesuré est envoyé à la base par paquets.
   L’import peut être arrêté et relancé : seuls les morceaux absents de la base sont mesurés.

Les morceaux déjà analysés depuis un dossier local (« Analyser un dossier de musique ») sont reliés au
serveur par titre et artiste, et envoyés aussi.

### 3. L’application Android

L’APK est construit par GitHub Actions (`.github/workflows/android.yml`) à chaque envoi sur le dépôt.

1. *(Facultatif)* Dans GitHub › *Settings* › *Secrets and variables* › *Actions* › **Variables**, créez
   `RUNBPM_SERVER` (`https://VOTRE_NOM.pythonanywhere.com`) et `NAVIDROME_URL` (adresse de Navidrome
   joignable de l’extérieur) : l’application les proposera d’office.
2. Sur le téléphone, téléchargez
   **https://github.com/PythDom/runbpm/releases/download/android-latest/RunBPM.apk** (publié à chaque
   mise à jour de `main` ; les autres branches produisent l’APK en *artifact* de l’action), ouvrez-le et
   autorisez l’installation depuis le navigateur. Les mises à jour s’installent par-dessus, sans perte
   de réglages.
3. Dans l’application : Navidrome (adresse **joignable hors de chez vous** pour courir dehors), puis le
   code d’accès de la base partagée. La bibliothèque arrive de la base, sans rien mesurer.

Pendant la lecture, une notification « RunBPM : course en cours » maintient l’application active écran
verrouillé (service Android « lecture multimédia ») ; l’option « Garder l’écran allumé » est appliquée
par l’application. Restent réservés à la version web sur PC : la connexion Spotify (retour de
connexion impossible vers l’application) et les exports de fichiers (M3U, CSV, JSON).

La clé de signature `android/app/runbpm.keystore` est volontairement dans le dépôt pour que chaque APK
puisse remplacer le précédent ; pour une clé privée, fournissez `RUNBPM_KEYSTORE`,
`RUNBPM_KEYSTORE_PASSWORD`, `RUNBPM_KEY_ALIAS` au build.

## 1. Bibliothèque : analyse du dossier de musique

« Analyser un dossier de musique » parcourt le dossier (sous-dossiers compris) :

- **Artiste / titre / durée** lus dans les tags — MP3 (ID3v1/v2, durée Xing/VBRI), FLAC, Ogg/Opus,
  M4A/AAC, WAV — sinon déduits du nom de fichier « Artiste - Titre ».
- **BPM** : celui des tags s’il existe (option), sinon **mesuré sur le signal** :
  flux spectral → autocorrélation → peigne sur 4 puis 16 battements, puis affinage par le suivi des
  temps (régression sur les temps détectés). Évalué sur 7 vrais morceaux libres face à madmom
  (référence de la recherche) : tempo exact à ±0,6 % sur toutes les musiques à tempo régulier
  (un morceau ressort au double, ce qui reste utilisable) ; les musiques au tempo fluctuant
  (orchestre, rubato) restent approximatives.
  Entre un tempo et son double, on retient le plus proche de 140 BPM (176 plutôt que 88) ; les deux
  conviennent de toute façon (un pas par temps ou par demi-temps).
- **Confiance** de la mesure : les morceaux sans pulsation nette sont signalés « à vérifier » ; sans
  pulsation du tout, ils sont écartés des playlists tant que leur BPM n’est pas corrigé.
- Les MP3 volumineux ne sont décodés que sur une tranche centrale : quelques centaines de ms par fichier.
- Les fichiers déjà analysés (même chemin, taille, date) sont ignorés lors d’une nouvelle analyse.
- Le tableau **Bibliothèque** permet de rechercher, filtrer les morceaux à vérifier, corriger un BPM
  (saisie, ×2, ÷2) ou retirer un morceau.

L’import CSV/JSON reste possible (voir *Formats d’entrée*).

## 2. Calcul de la playlist

1. **Parcours** → rééchantillonné tous les 20 m, altitude lissée (bruit GPS), puis découpé en
   **sections de pente homogène** (≥ 250 m, voisines de pente similaire fusionnées).
2. **Plan de course** → pour chaque section : vitesse, temps de passage et cadence cible.
   - *Allure constante* : même vitesse partout.
   - *Effort constant* : vitesse modulée par le coût énergétique de la pente (Minetti et al., 2002,
     atténué et borné), en conservant l’allure moyenne demandée.
   - Cadence = cadence sur le plat **X** (saisie, calibrée, ou estimée : ≈ 140 + 3 × vitesse en km/h),
     ajustée selon la **tranche de pente** de la section (tableau ci-dessous).
3. **Choix des morceaux** → on avance dans le temps de course et on choisit à chaque fois le morceau dont
   le tempo colle le mieux à la cadence cible **sur toute sa durée d’écoute**. Les services de streaming
   jouent au tempo original : seuls les morceaux déjà au bon BPM (ou à mi-tempo) sont retenus.

### Cadence selon la pente

Principe : garder une cadence à peu près stable et laisser la longueur de foulée absorber la pente.
Valeurs par défaut, **modifiables par profil** (carte Course › « Cadence selon la pente et calibrage ») ;
une borne appartient à la tranche la plus raide (+5 % = montée modérée, −5 % = descente modérée).

| Pente | Cadence | Conseil affiché pendant la course |
|---|---|---|
| ≥ +15 % | 120 pas/min (marche active) | grandes foulées décidées, mains sur les cuisses, rythme régulier |
| +10 à +15 % | X − 7 | petits pas élastiques ; se régler sur l’effort ou la FC |
| +5 à +10 % | X + 3 | pas plus courts, médio-pied, inclinaison depuis les chevilles, bras actifs |
| +1 à +5 % | X | garder la cadence, raccourcir la foulée |
| −1 à +1 % | X | cadence de référence |
| −1 à −5 % | X + 3 | laisser la gravité allonger la foulée, rester relâché |
| −5 à −10 % | X + 7 | pieds sous le corps, légère inclinaison vers l’avant |
| < −10 % | 190 pas/min | pas rapides et légers, bras écartés, genoux souples, contrôler la vitesse par la fréquence |

Le tableau des sections indique la tranche de chacune, et le conseil s’affiche pendant la course.

### Profils coureur et calibrage personnel

Chaque **profil coureur** (carte Course) garde ses propres réglages : cadence au plat et tableau des
tranches de pente. On peut aussi **calibrer** un profil avec une
ou plusieurs sorties de sa montre (**FIT** ou TCX avec cadence), de préférence vallonnées :

- les sorties sont découpées en tronçons de 100 m (vitesse, pente, cadence) ; arrêts, marche, cadences
  aberrantes et pentes extrêmes sont écartés ; la cadence « un pied » des montres est doublée ;
- le modèle `cadence = k0 + kv × vitesse + a × montée(%) + b × descente(%)` est ajusté par moindres
  carrés, avec un rappel doux vers les valeurs par défaut : une sortie plate ne renseigne pas sur la
  pente, les coefficients de pente restent alors proches de 0,6 / 0,3 ;
- une fois calibré, la cadence au plat X suit l'allure choisie ; les tranches de pente s'appliquent
  ensuite (les coefficients de pente mesurés sont affichés pour information).

Le lecteur FIT est intégré (sans dépendance) : en-têtes compressés, gros/petit-boutisme, CRC, activités
autres que la course à pied refusées.

## 3. Lecture ou création de la playlist

### Navidrome / Subsonic (lecture dans RunBPM)
Pour un serveur auto-hébergé compatible Subsonic / OpenSubsonic (Navidrome, Gonic, Airsonic…).

- **Connexion** : adresse du serveur (ex. `http://192.168.1.10:4533`), utilisateur, mot de passe.
  Authentification Subsonic par jeton : seuls l’utilisateur, le sel et `md5(mot de passe + sel)` sont
  conservés dans le navigateur, jamais le mot de passe. Reconnexion automatique au rechargement.
- **Import de la bibliothèque** (`search3` par pages de 500) : BPM des tags du serveur s’il existe
  (option), sinon mesuré sur un extrait : tranche centrale lue par requête HTTP *Range* pour les MP3,
  début du morceau transcodé en MP3 par le serveur pour les autres formats (à défaut, fichier d’origine).
  Un morceau déjà présent dans la bibliothèque (même titre et artiste) est relié au serveur sans nouvelle
  analyse ; ses corrections de BPM sont conservées.
- **Lecture** : fichier d’origine diffusé par le serveur, vitesse de lecture ajustée (± « Tempo ajustable »,
  4 % par défaut, `preservesPitch`), barre de position, morceau suivant / précédent, commandes de l’écran
  verrouillé (Media Session), métronome superposable.
- **Métronome calé sur les temps** : chaque morceau est décodé et ses temps repérés (suivi des temps par
  programmation dynamique, Ellis 2007 ; ±6 ms des temps annotés par madmom sur de vrais morceaux) ; les
  clics sont planifiés sur ces temps d’après la position de lecture et la vitesse ajustée, y compris après
  un déplacement dans le morceau. Un réglage « Décalage des clics » (±150 ms, mémorisé par appareil)
  compense la latence audio (écouteurs Bluetooth…). Tant que les temps ne sont pas repérés, le
  métronome bat librement.
- **« Créer la playlist dans Navidrome »** : pour l’écouter aussi depuis vos autres applications Subsonic
  (au tempo original, l’ajustement n’existant que dans RunBPM).
- Navidrome autorise les appels depuis n’importe quelle page (CORS). Si RunBPM est servi en HTTPS, le
  serveur doit l’être aussi (sinon le navigateur bloque) : en local, ouvrez RunBPM en `http://127.0.0.1`.

### Base partagée et sélection « course »

Avec une base partagée (voir *Installation*), RunBPM garde une **liste commune** des morceaux du
serveur avec leur BPM :

- le premier import mesure les morceaux et les enregistre ; **les suivants (tous utilisateurs, tous
  appareils) ne mesurent que les morceaux absents de la base**. À la connexion, la bibliothèque est
  remplie depuis la base en une fraction de seconde ;
- une **correction manuelle** du BPM est partagée et n’est jamais écrasée par une nouvelle analyse ;
- chaque utilisateur **coche** dans la Bibliothèque les morceaux qu’il veut entendre en courant (case par
  morceau, case d’en-tête pour les morceaux affichés, filtre « Cochés seulement »), puis active
  « Morceaux cochés seulement » dans les options de sélection. La sélection est propre à chaque
  utilisateur et le suit d’un appareil à l’autre ;
- **identité** : un code d’accès `nom:secret` par personne, créé par l’administrateur
  (`runbpm_server.py adduser`) ; le serveur n’en garde que l’empreinte SHA-256.

API (`/api/…`, en-tête `X-RunBPM-Key`) : `health`, `whoami`, `songs` (GET, `?since=` ; POST par lots),
`songs/<id>` (PATCH du BPM), `selection` (GET, PUT). CORS ouvert : aucune donnée de session n’est
transmise par cookie.

Sans base partagée, tout fonctionne comme avant : bibliothèque et sélection restent dans l’appareil.

### Spotify
« Créer la playlist Spotify » cherche chaque morceau sur Spotify (titre, artiste, durée ; seules les
correspondances sûres sont retenues). Les morceaux **introuvables sont remplacés** et la playlist est
recalculée, pour que la playlist Spotify corresponde exactement au calcul (sinon la musique et le
métronome se décaleraient). La playlist est créée en privé dans votre compte.

**Configuration (une fois)** : RunBPM est une page statique sans serveur, chaque utilisateur utilise
donc sa propre application Spotify :
1. créer une application sur [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) (Web API) ;
2. y déclarer l’adresse de redirection affichée dans la carte « Streaming » (l’adresse de la page ;
   en local `http://127.0.0.1:5173/`, Spotify refusant `localhost`) ;
3. dans *User Management*, ajouter les comptes autorisés (5 maximum en mode développement) ;
4. coller le *Client ID* dans RunBPM et se connecter (OAuth PKCE : aucun secret).

Limites imposées par Spotify (2026) : compte Premium obligatoire en mode développement, 5 utilisateurs
par application, tempo des morceaux non fourni par l’API (d’où l’analyse de vos fichiers).

### Deezer
Deezer ne permet plus aux applications tierces de créer des playlists (création d’applications
développeur fermée). « Exporter pour Deezer » télécharge la liste « Artiste - Titre » (une ligne par
morceau), à importer dans Deezer avec un service de transfert de playlists (TuneMyMusic, Soundiiz…).
La disponibilité des morceaux sur Deezer ne peut pas être vérifiée : un morceau absent sera sauté.

### Sans service
Export M3U pour n’importe quel lecteur de musique (les chemins des fichiers analysés y figurent).

## 4. Pendant la course : le métronome

La carte « Pendant la course » superpose un métronome (Web Audio) au tempo du morceau censé jouer.

- **Spotify connecté** : toutes les 4 s, RunBPM lit le morceau et la position joués par l’application
  Spotify ; le métronome suit, y compris les sauts de morceau, et se tait pendant les pauses.
- **Deezer / sans service** : mode chronomètre. Lancez la playlist au premier morceau et appuyez sur
  Départ au même moment ; ◀ ▶ (ou un clic sur un numéro de la playlist) recalent le métronome.
- Affichage : morceau attendu, temps de course, km estimé, cadence cible à cet endroit.
- L’écran est gardé allumé (Wake Lock) : le navigateur mobile coupe sinon l’audio en arrière-plan.
- Avec Spotify ou Deezer, le métronome donne le bon tempo mais n’est pas calé sur les temps du morceau
  (l’application n’a pas accès au son joué par leurs applications) ; avec Navidrome, il l’est.

## Formats d’entrée

### Parcours
- **GPX** (`<trkpt>` ou `<rtept>` avec `<ele>`) : export de Strava, Garmin, Komoot, OpenRunner…
- **TCX** (Garmin, `AltitudeMeters`, `DistanceMeters`).
- **JSON RunBPM**, deux variantes :

```json
{ "name": "Mon parcours", "points": [ { "lat": 45.90, "lon": 6.12, "ele": 420 } ] }
{ "name": "Profil seul",  "profile": [ { "distance": 0, "ele": 100 }, { "distance": 2000, "ele": 160 } ] }
```
(`distance` en mètres depuis le départ ; `profile` accepte aussi des couples `[distance, altitude]`.)

### Bibliothèque musicale
CSV (séparateur `,` `;` ou tabulation) ou JSON. Colonnes reconnues (FR/EN) :

| Champ | Noms acceptés | Obligatoire |
|---|---|---|
| Tempo | `bpm`, `tempo` | oui |
| Durée | `duration`, `durée`, `duration (ms)`, `length`… (`3:45`, secondes ou ms) | oui |
| Titre | `title`, `titre`, `track name`, `name`… | non |
| Artiste | `artist`, `artiste`, `artist name(s)`… | non |
| Fichier | `file`, `fichier`, `path`, `url` (repris dans le M3U) | non |
| Spotify | `spotify`, `track uri`, `uri` : `spotify:track:…`, lien `open.spotify.com/track/…` ou ID | non |

Les exports de playlists au format *Exportify* (colonnes `Track Name`, `Artist Name(s)`, `Duration (ms)`, `Tempo`)
sont reconnus directement. Exemple : [`public/samples/bibliotheque-exemple.csv`](public/samples/bibliotheque-exemple.csv).
La bibliothèque (analysée ou importée) est mémorisée dans le navigateur.

## Organisation du code

```
src/core/          moteur, sans dépendance au DOM (testé)
  route.ts           lecture GPX / TCX / JSON, distances (haversine), altitudes manquantes
  sections.ts        rééchantillonnage, lissage, découpage en sections de pente
  pacing.ts          plan de course : vitesse, cadence, modèle de Minetti
  library.ts         bibliothèque, import CSV/JSON
  bpm.ts             détection du tempo (flux spectral, autocorrélation, peigne)
  beats.ts           suivi des temps (programmation dynamique) et affinage du tempo
  md5.ts             MD5 pour l’authentification Subsonic
  fit.ts             lecture des fichiers FIT (montres)
  activity.ts        sortie enregistrée → tronçons vitesse / pente / cadence
  calibration.ts     ajustement du modèle personnel de cadence
  tags.ts            lecture des tags ID3 / FLAC / Ogg / MP4 / WAV et des durées
  names.ts           noms de fichiers, normalisation
  playlist.ts        sélection des morceaux
  timeline.ts        morceau attendu à un instant donné, recherche par identifiant Spotify
  spotifyMatch.ts    choix du bon résultat de recherche Spotify
  export.ts          M3U / CSV / JSON / liste pour transfert (Deezer)
  demo.ts            bibliothèque fictive de démonstration
  slopeRules.ts      tranches de pente → cadence, conseils de course
src/services/spotify.ts   connexion OAuth PKCE, recherche, création de playlist, état du lecteur
src/services/subsonic.ts  client Subsonic / Navidrome (jeton, search3, stream, Range, playlists)
src/services/sharedDb.ts  client de la base partagée, fusion avec la bibliothèque locale
src/ui/            interface (TypeScript sans framework)
  analyzer.ts        analyse des fichiers audio (décodage Web Audio + tags + tempo)
  navidromeImport.ts import de la bibliothèque du serveur, mesure du tempo à distance
  navidromePanel.ts  connexion au serveur Navidrome
  player.ts          lecteur interne (flux du serveur, ajustement du tempo, métronome superposé)
  profiles.ts        profils coureur et calibrage
  libraryView.ts     tableau de la bibliothèque (correction des BPM, morceaux cochés)
  selection.ts       sélection « course » (appareil + serveur)
  sharedPanel.ts     réglage de la base partagée (adresse, code d’accès)
  native.ts          pont vers l’application Android (service de course, écran allumé)
  companion.ts       compagnon de course (chronomètre / synchro Spotify, Wake Lock)
  metronome.ts       métronome Web Audio
  spotifyPanel.ts    connexion Spotify
  chart.ts           graphique SVG
tests/             tests vitest (dont signaux et fichiers audio synthétiques)
scripts/generate-samples.mjs   régénère les fichiers d’exemple
server/            base partagée (Python, bibliothèque standard)
  runbpm_server.py   application WSGI + SQLite + commandes (adduser, serve, export…)
  pythonanywhere_wsgi.py  modèle de fichier WSGI pour PythonAnywhere
  test_runbpm_server.py   tests (python -m unittest discover -s server)
android/           application Android (Capacitor) : service « course en cours »
.github/workflows/android.yml  tests + construction et publication de l’APK
```

## Pistes d’évolution
- Vérifier la disponibilité des morceaux sur Deezer via son API publique de recherche.
- Analyse en tâche de fond (Web Worker) pour les très grosses collections.
