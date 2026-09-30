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

Application web 100 % locale : tout est calculé dans le navigateur, aucun fichier audio n’est envoyé.

## Démarrage

```bash
npm install
npm run dev      # http://127.0.0.1:5173 (Spotify refuse « localhost »)
npm test         # tests unitaires (vitest)
npm run build    # version statique dans dist/ (déployable telle quelle, ex. GitHub Pages)
```

Essai rapide : « Essayer la boucle vallonnée d’exemple », puis « Bibliothèque de démo ».

## 1. Bibliothèque : analyse du dossier de musique

« Analyser un dossier de musique » parcourt le dossier (sous-dossiers compris) :

- **Artiste / titre / durée** lus dans les tags — MP3 (ID3v1/v2, durée Xing/VBRI), FLAC, Ogg/Opus,
  M4A/AAC, WAV — sinon déduits du nom de fichier « Artiste - Titre ».
- **BPM** : celui des tags s’il existe (option), sinon **mesuré sur le signal** :
  flux spectral → autocorrélation → peigne sur 4 puis 16 battements (précision ≈ 0,3 BPM).
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
   - Cadence = cadence sur le plat (saisie par le coureur, ou estimée : ≈ 140 + 3 × vitesse en km/h)
     \+ 0,6 pas/min par % de montée, + 0,3 pas/min par % de descente (réglables).
3. **Choix des morceaux** → on avance dans le temps de course et on choisit à chaque fois le morceau dont
   le tempo colle le mieux à la cadence cible **sur toute sa durée d’écoute**. Les services de streaming
   jouent au tempo original : seuls les morceaux déjà au bon BPM (ou à mi-tempo) sont retenus.

### Profils coureur et calibrage personnel

Chaque **profil coureur** (carte Course) garde ses propres réglages : cadence au plat, coefficients de
montée et de descente. Dans « Réglages avancés et calibrage », on peut **calibrer** un profil avec une
ou plusieurs sorties de sa montre (**FIT** ou TCX avec cadence), de préférence vallonnées :

- les sorties sont découpées en tronçons de 100 m (vitesse, pente, cadence) ; arrêts, marche, cadences
  aberrantes et pentes extrêmes sont écartés ; la cadence « un pied » des montres est doublée ;
- le modèle `cadence = k0 + kv × vitesse + a × montée(%) + b × descente(%)` est ajusté par moindres
  carrés, avec un rappel doux vers les valeurs par défaut : une sortie plate ne renseigne pas sur la
  pente, les coefficients de pente restent alors proches de 0,6 / 0,3 ;
- une fois calibré, la cadence au plat suit l'allure choisie, et l'effet de la vitesse est appliqué
  section par section (en « effort constant », ralentir en montée baisse aussi un peu la cadence).

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
- **« Créer la playlist dans Navidrome »** : pour l’écouter aussi depuis vos autres applications Subsonic
  (au tempo original, l’ajustement n’existant que dans RunBPM).
- Navidrome autorise les appels depuis n’importe quelle page (CORS). Si RunBPM est servi en HTTPS, le
  serveur doit l’être aussi (sinon le navigateur bloque) : en local, ouvrez RunBPM en `http://127.0.0.1`.

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
- Le métronome donne le bon tempo mais n’est pas calé sur les temps du morceau (phase inconnue :
  l’application n’a pas accès au son joué par Spotify ou Deezer).

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
src/services/spotify.ts   connexion OAuth PKCE, recherche, création de playlist, état du lecteur
src/services/subsonic.ts  client Subsonic / Navidrome (jeton, search3, stream, Range, playlists)
src/ui/            interface (TypeScript sans framework)
  analyzer.ts        analyse des fichiers audio (décodage Web Audio + tags + tempo)
  navidromeImport.ts import de la bibliothèque du serveur, mesure du tempo à distance
  navidromePanel.ts  connexion au serveur Navidrome
  player.ts          lecteur interne (flux du serveur, ajustement du tempo, métronome superposé)
  profiles.ts        profils coureur et calibrage
  libraryView.ts     tableau de la bibliothèque (correction des BPM)
  companion.ts       compagnon de course (chronomètre / synchro Spotify, Wake Lock)
  metronome.ts       métronome Web Audio
  spotifyPanel.ts    connexion Spotify
  chart.ts           graphique SVG
tests/             tests vitest (dont signaux et fichiers audio synthétiques)
scripts/generate-samples.mjs   régénère les fichiers d’exemple
```

## Pistes d’évolution
- Vérifier la disponibilité des morceaux sur Deezer via son API publique de recherche.
- Analyse en tâche de fond (Web Worker) pour les très grosses collections.
