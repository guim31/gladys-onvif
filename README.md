# ONVIF for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) integration for **ONVIF IP
cameras** (Hikvision, Dahua, Amcrest, Reolink, TP-Link Tapo and VIGI, Axis,
Foscam, Annke, Uniview, most network video recorders): discovery, images,
pan/tilt/zoom, preset positions and detections, over the local network. No
cloud.

> **Developed without the hardware: feedback welcome.** Everything was built
> and tested against the Happytime ONVIF server (a complete software camera),
> against simulated cameras answering like Hikvision and TP-Link Tapo models,
> and against real event messages recorded by the onvif-parsers project, not
> against a real camera. Please report what works and what does not on the
> [Gladys forum](https://community.gladysassistant.com) or in the
> [issues](https://github.com/guim31/gladys-onvif/issues).

## Features

- **Automatic discovery**: the Gladys core broadcasts a WS-Discovery probe on
  the local network for the integration (mediated discovery), the cameras
  answer with their address. Addresses can be typed for the cameras that only
  listen in multicast, or on another network.
- **Up to three accounts**: each camera keeps the one it accepts. An account a
  camera refused is not sent to it again until the accounts change or the user
  runs a search: cameras lock an account after a few wrong passwords.
- **One Gladys device per video source** (a recorder gives one per channel):
  - the **image**, from the camera's snapshot address or, without one, a frame
    of its RTSP stream, scaled down with ffmpeg to the 150 KB Gladys accepts,
    sent at the chosen pace (10 s to 15 min) and a few seconds after each
    detection or movement, and on demand (dashboard, "Send a camera image");
  - for motorized cameras, the **movement** feature of the Gladys PTZ contract
    (left, right, up, down, zoom in, zoom out, only those the camera can do),
    every move bounded by a watchdog, and the **preset positions** with their
    names, re-read every 15 minutes;
  - one **sensor per detection** the camera reports: motion, person, vehicle,
    animal, line crossing, intrusion, tampering.
- **Events** through an ONVIF PullPoint subscription (long polling, renewed,
  started again after an error): a detection reaches Gladys within a second
  or two.
- **Dashboard widget** _ONVIF camera_: the image, what the camera detects,
  and up to four one-tap buttons (directions, zoom, presets) that come back
  with the new view.
- **Scene trigger** _ONVIF camera detection_ (camera, kind of detection, also
  sound and doorbell), **scene actions** _Move a camera to a preset_ (by name)
  and _Move a camera_ (direction and duration).
- Texts in English, French, German and Spanish.

## Requirements

- Gladys Assistant **5.1.0** or later.
- Cameras with ONVIF turned on (Profile S) and an ONVIF account. The
  [documentation](docs/en.md) says where to find it for the common brands.

## Installation

In Gladys: **Integrations** → **Install from GitHub**, address
`https://github.com/guim31/gladys-onvif`. Then fill in the account in the
**Configuration** of the integration and open its **Discovery** tab.

User documentation: [English](docs/en.md), [Français](docs/fr.md),
[Deutsch](docs/de.md), [Español](docs/es.md).

## How it works

- `src/discovery.js`: the WS-Discovery probe (487 bytes: the core caps the
  payload at 512, so it goes without XML declaration nor `Types` filter) and
  the reading of the answers; printers and other WS-Discovery devices are left
  out.
- `src/onvif/`: a small ONVIF client written for the integration, without
  dependency: SOAP 1.2 with WS-Security password digest and the camera clock
  offset (`soap.js`), HTTP Digest and Basic (`http.js`, `digest.js`), an XML
  reader by local names that refuses document types (`xml.js`), the device,
  media, PTZ and event operations (`camera.js`) and the meaning of the event
  topics (`events.js`).
- `src/hub.js`: the cameras, their devices, images, PTZ queue and watchdog,
  the event loops, reachability and the scene trigger.
- `src/image.js`: ffmpeg, one process at a time, on pipes; the stream address
  holds the credentials and never appears in a log or an error.
- The Docker image adds `ffmpeg` (Alpine package) for the images.

## Checked, and what was not

Checked:

- The test suite (`npm test`), against simulated cameras that check the
  WS-Security digest and the clock: the answers recorded from the Happytime
  ONVIF server, a Hikvision-like fixed camera (Zulu timestamps, dashed
  subscription times, Digest snapshot) and a Tapo-like pan/tilt camera
  (port 2020, no snapshot address, reference parameters on the subscription),
  plus real event payloads of Hikvision, Reolink and Tapo cameras.
- In Docker, with the Gladys sandbox constraints (read-only rootfs, all
  capabilities dropped, 256 MB): the image starts and retries Gladys without
  crashing nor logging secrets (20 MB at rest); against the Happytime ONVIF
  server (authentication on and off), a simulated Tapo camera with a real RTSP
  stream (MediaMTX) and a simulated Hikvision camera: discovery by broadcast,
  accounts refused then accepted, images from the snapshot and from RTSP
  through ffmpeg, moves, presets, detections and triggers with the SDK's fake
  Gladys (under 50 MB).

Not checked: a real camera of any brand, and a real Gladys instance.

## Limitations

- Images, not video (Gladys takes at most 12 images a minute per camera).
- Only the ONVIF media service version 1 (Profile S); cameras speaking only
  Media2 (Profile T without Profile S) are not supported yet.
- Cameras that only answer WS-Discovery in multicast are not found
  automatically: type their address.
- One movement at a time, at half speed; presets are recalled, not created.
- No ONVIF events pushed by the camera (the container cannot be reached from
  the LAN): the integration pulls them.

## Development

```bash
npm ci
npm run format:check
npm run lint
npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

See [CLAUDE.md](CLAUDE.md) for the project rules and the ONVIF notes.

## Credits

- The event topics follow [onvif-parsers](https://github.com/openvideolibs/onvif-parsers)
  (Apache 2.0) and the [Home Assistant ONVIF integration](https://www.home-assistant.io/integrations/onvif)
  (Apache 2.0); their tests provided real event payloads
  (`test/fixtures/onvif/notifications.json`).
- The Hikvision quirks (Zulu WS-Security time, dashed subscription times) come
  from [onvif-zeep-async](https://github.com/openvideolibs/python-onvif-zeep-async)
  (MIT) and its simulated Hikvision camera.
- `test/fixtures/onvif/happytime/` holds answers recorded from the
  [Happytime ONVIF server](https://www.happytimesoft.com) test edition, as the
  [agsh/onvif](https://github.com/agsh/onvif) library (MIT) uses it for its
  own tests; addresses anonymized.
- The HTTP Digest helper comes from
  [gladys-fritzbox](https://github.com/guim31/gladys-fritzbox).

## Disclaimer

Not affiliated with, endorsed by or certified by ONVIF, nor by any camera
maker. ONVIF is a trademark of Onvif, Inc.; the other names are trademarks of
their owners. This integration does not claim ONVIF conformance.

## License

[Apache License 2.0](LICENSE).
