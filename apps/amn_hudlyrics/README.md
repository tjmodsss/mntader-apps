# HUD Lyrics

Synced lyrics for the song playing over CarPlay (Apple Music, Spotify...), one line at a time in the
head-up display, with a Now Playing page on the centre screen. iDrive 7 · package `amn_hudlyrics` · version 0.3.0.

## Centre screen

The song, its artist and album and a progress line on the left; the lyrics on the right, the line being sung
large and white, the line before and the line after dim. Along the bottom, four status pills say what each
part is doing, each with a coloured dot (green working, amber waiting, grey off, red a problem):

| Pill | Says |
|---|---|
| Song | Playing, Paused, or Nothing playing |
| Timing | From the car, or "Tap Song just started" for a source that sends no time |
| Lyrics | Synced (and how many lines), Searching, Not synced, Not on LRCLIB, Car offline |
| HUD · experimental | Off, Showing lyrics, Waiting - HUD in use, Hidden - route guidance, Needs Cluster renderer |

If the HUD stays dark, the pills say which part stopped.

## The HUD (experimental)

Off until you switch on **Settings > Lyrics in the HUD (experimental)**. Then, while a song with synced lyrics
plays, the line being sung shows in the HUD, inside its visible window and above the speed readout, drawn at
the HUD's own resolution (no stretching). One line: a new line fades in where the last one was. Two lines: the
next one dim below. Three lines: the line before dim above, the line sung white, the next dim below, and at each
new line all three slide up one place, as Apple Music scrolls its lyrics. It hides during route guidance (BMW navigation, CarPlay, Android Auto), when
paused for 30 s, and for a song without synced lyrics.

Only one app can draw in the HUD at a time: with HUD Lyrics on, other HUD apps (bimmer-lab HUD Widgets, G's Dash
HUD, Redline's HUD) wait, and the other way round. Needs the **Cluster renderer** tool from the Store. If a
black box stays in the HUD after switching off or removing the app, restart the head unit (Store > Settings >
Restart head unit).

The text area comes from measurements on a 2020 X3. If it sits off-centre on your car, report it.

## Settings

| Setting | Choices | Default |
|---|---|---|
| Lyrics in the HUD (experimental) | on / off | off |
| HUD lines | One line; Two lines (next one dim); Three lines (before, now, after) | One line |
| HUD text size | Small (26 px), Medium (32 px), Large (38 px) | Medium |
| Show during navigation | on / off | off |
| Lyrics timing | 3 s earlier to 3 s later | 0 |

**Song just started** (bar button): for a source that sends no time, tap it as the song starts.

## What it uses

- **Car:** reads the track from BMW's MediaPlayer, CarPlayManager, HmiMediaState and DynamicMediaPlayer, and
  route guidance from NavigationStatus and the Android Auto manager. It subscribes and reads only; it never
  writes a value or calls a method.
- **Internet:** one host, `lrclib.net`, through the Store's uplink. `net/http.js` refuses any other host.
- **HUD:** the Store's Cluster renderer, through its own client on the head unit.
- **Log:** the track's title, artist and timing, the lyrics lookup's result and the HUD layer's state.
- **No** accounts, album art, analytics or crash-report uploads.

## Credits

Built from [arefahmad/idrive7-apps](https://github.com/arefahmad/idrive7-apps)' Car Lyrics (MIT): `car/nowplaying.js`,
`net/http.js` and the song clock. `stage/lyrics.js` and `hud/` (the HUD layer) are from nickgcode's G's Music
(MIT, `LICENSE`). Fonts: Inter (SIL Open Font License, `data/fonts/LICENSE-Inter.txt`). See the repository's NOTICE.

## Screens

Rendered on a computer from the app's own drawing code, with a made-up song and made-up lyrics; not photos of a car.

![Now Playing](../../docs/screenshots/amn_hudlyrics/screen-playing.png)

![Nothing playing](../../docs/screenshots/amn_hudlyrics/screen-empty.png)

The HUD, one line (default), two lines and three lines, over a mock windshield. Green: the HUD's visible window measured on a
2020 X3. Orange: where the text may go. Grey: BMW's speed readout.

![HUD, one line](../../docs/screenshots/amn_hudlyrics/hud-one-line-medium.png)

![HUD, two lines](../../docs/screenshots/amn_hudlyrics/hud-two-lines-medium.png)

![HUD, three lines](../../docs/screenshots/amn_hudlyrics/hud-three-lines-medium.png)
