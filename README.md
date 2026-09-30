# RunBPM

Génère une playlist dont le tempo (BPM) suit la **cadence de course idéale** tout au long d’un parcours,
en tenant compte du **dénivelé** et de l’**allure désirée**. Le coureur cale ses pas sur la musique et garde
naturellement la bonne cadence, en montée comme en descente.

Application web 100 % locale : tout est calculé dans le navigateur, aucun fichier n’est envoyé.

## Démarrage

```bash
npm install
npm run dev      # http://127.0.0.1:5173 (Spotify refuse « localhost »)
npm test         # tests unitaires (vitest)
npm run build    # version statique dans dist/ (déployable telle quelle, ex. GitHub Pages)
```

Dans l’application : cliquez sur « Essayer la boucle vallonnée d’exemple » puis « Utiliser la bibliothèque de démo ».

## Fonctionnement

1. **Parcours** → rééchantillonné tous les 20 m, altitude lissée (bruit GPS), puis découpé en
   **sections de pente homogène** (≥ 250 m, voisines de pente similaire fusionnées).
2. **Plan de course** → pour chaque section : vitesse, temps de passage et cadence cible.
   - *Allure constante* : même vitesse partout.
   - *Effort constant* : vitesse modulée par le coût énergétique de la pente (Minetti et al., 2002,
     atténué et borné), en conservant l’allure moyenne demandée.
   - Cadence = cadence sur le plat (saisie par le coureur, ou estimée : ≈ 140 + 3 × vitesse en km/h)
     \+ 0,6 pas/min par % de montée, + 0,3 pas/min par % de descente (réglables).
3. **Playlist** → on avance dans le temps de course et on choisit à chaque fois le morceau dont le tempo
   colle le mieux à la cadence cible **sur toute sa durée d’écoute** (la cadence peut changer en cours de morceau).
   - *Mi-tempo* : un morceau à 88 BPM convient pour 176 pas/min (un pas par demi-temps).
   - *Ajustement de tempo* : vitesse de lecture conseillée, ±4 % max par défaut (quasi inaudible).
   - Les morceaux naturellement au bon tempo sont préférés ; « Autre proposition » donne une variante.
4. **Lecteur intégré** (voir ci-dessous) et **exports** : M3U (lecteurs audio), CSV, JSON (plan + playlist).

## Lecteur intégré

- **Associer vos fichiers audio** (ou tout un dossier) : chaque fichier est relié à un morceau de la
  bibliothèque par son nom : colonne `fichier` de la bibliothèque, sinon « Artiste - Titre », « Titre »…
  (numéros de piste, accents et casse ignorés). Les fichiers restent sur votre appareil ; il faut les
  resélectionner après un rechargement de la page.
- **Ajustement du tempo** : chaque morceau est lu à la vitesse conseillée (`playbackRate`, ±4 % par défaut)
  **sans changer la hauteur de la voix** (`preservesPitch`).
- **Métronome** (Web Audio, clics planifiés sur l'horloge audio) :
  - joue à la place des morceaux sans fichier associé (la bibliothèque de démo est donc jouable telle quelle) ;
  - peut être superposé à la musique pour trouver le rythme (il n'est pas calé sur les temps du morceau).
- Affichage en direct : cadence imposée, position estimée sur le parcours (km) et cadence cible à cet endroit.
- Lecture depuis n'importe quel morceau (clic sur son numéro), barre d'espace = lecture/pause,
  commandes de l'écran verrouillé et des écouteurs (Media Session).
- Modifier l'allure, le parcours ou la bibliothèque recalcule la playlist et remet le lecteur au début.

## Spotify (optionnel)

Les morceaux de la bibliothèque peuvent être lus depuis un compte **Spotify Premium**, soit dans
le navigateur (Web Playback SDK), soit sur un autre appareil via Spotify Connect (typiquement :
l'application Spotify du téléphone pendant la course, RunBPM servant de télécommande).

**Configuration (une fois)** : RunBPM est une page statique sans serveur, chaque utilisateur utilise
donc sa propre application Spotify :
1. créer une application sur [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
   (Web API + Web Playback SDK) ;
2. y déclarer l'adresse de redirection affichée dans la carte « Spotify » (l'adresse de la page ;
   en local `http://127.0.0.1:5173/`, Spotify refusant `localhost`) ;
3. dans *User Management*, ajouter les comptes autorisés (5 maximum en mode développement) ;
4. coller le *Client ID* dans RunBPM et se connecter (OAuth PKCE : aucun secret).

**Fonctionnement**
- Un morceau est lu via Spotify s'il a un identifiant Spotify (colonne `spotify`, `track uri`, `uri`,
  ou un lien `open.spotify.com/track/…`) et **aucun fichier local** (le fichier local reste prioritaire).
- « Lier la bibliothèque à Spotify » recherche les morceaux sans identifiant et ne retient que les
  correspondances sûres (titre, artiste et durée).
- **Pas d'ajustement de tempo** : Spotify ne permet pas de modifier la vitesse de lecture. La playlist
  ne retient donc pour ces morceaux que ceux dont le BPM correspond déjà à la cadence.
- « Créer dans Spotify » enregistre la playlist (privée) dans le compte, pour courir avec la seule
  application Spotify.

**Limites imposées par Spotify (2026)** : Premium obligatoire, 5 utilisateurs par application en mode
développement, tempo des morceaux (audio-features) non fourni par l'API : le BPM doit venir de votre
bibliothèque. Le lecteur intégré au navigateur n'est pas disponible partout (lecture en arrière-plan
impossible sur iOS) : sur téléphone, préférez la lecture sur l'application Spotify.

**Deezer** n'est pas pris en charge : Deezer n'accepte plus la création d'applications développeur et
son SDK de lecture est abandonné ; aucune lecture complète n'est possible depuis une application tierce.

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
La bibliothèque importée est mémorisée dans le navigateur.

## Organisation du code

```
src/core/     moteur, sans dépendance au DOM (testé)
  route.ts      lecture GPX / TCX / JSON, distances (haversine), altitudes manquantes
  sections.ts   rééchantillonnage, lissage, découpage en sections de pente
  pacing.ts     plan de course : vitesse, cadence, modèle de Minetti
  library.ts    import CSV/JSON des morceaux
  playlist.ts   sélection des morceaux
  export.ts     M3U / CSV / JSON
  audioMatch.ts association fichiers audio ↔ morceaux
  spotifyMatch.ts choix du bon résultat de recherche Spotify
src/services/spotify.ts   connexion OAuth PKCE, Web API, Web Playback SDK
  demo.ts       bibliothèque fictive de démonstration
src/ui/       interface (TypeScript sans framework), graphique SVG,
              lecteur (player.ts), métronome Web Audio (metronome.ts), carte Spotify (spotifyPanel.ts)
tests/        tests vitest
scripts/generate-samples.mjs   régénère les fichiers d’exemple
```

## Pistes d’évolution
- Caler le métronome superposé sur les temps réels du morceau (détection de la phase des battements).
- Détection automatique du BPM des fichiers audio importés.
- Connexion à un service de streaming (création de la playlist directement dans le compte).
- Calibrage personnel de la cadence à partir d’une sortie enregistrée (fichier FIT/TCX avec cadence).
- Transitions synchronisées sur les changements de section.
