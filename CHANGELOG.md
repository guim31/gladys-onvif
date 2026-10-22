# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.2] - 2026-10-22

### Security

- Rebuilt on Node.js 24.22.1, the October 2026 security release (remote code
  execution in the Brotli decoder, CVE-2026-111497; TLS hostname and DNS
  fixes).

## [1.0.1] - 2026-10-13

### Changed

- Quieter logs: a failure tried again and again (stream without image,
  refused snapshot, discovery through Gladys unavailable, states not taken,
  events interrupted, stop of a movement retried, state file not writable) now
  writes one line when it starts and one when it ends, instead of one per
  attempt; a new kind of detection reported by a camera is no longer logged at
  the info level. `LOG_LEVEL=debug` still shows every attempt.

## [1.0.0] - 2026-10-13

### Added

- ONVIF IP cameras found automatically on the local network (WS-Discovery
  through Gladys), or added by their address; up to three accounts, a refused
  account is not tried again until the accounts change or a search is run.
- One device per camera (per channel on a recorder): its image, refreshed at
  the chosen pace and after each detection or movement, from the snapshot
  address or the RTSP stream, scaled to fit Gladys.
- Pan, tilt and zoom of motorized cameras, each move stopped by a watchdog,
  and their preset positions by name.
- Motion, person, vehicle, animal, line crossing, intrusion and tampering
  sensors, from the camera's ONVIF events.
- Scene trigger "ONVIF camera detection", scene actions "Move a camera to a
  preset" and "Move a camera", dashboard widget "ONVIF camera".
- Texts and documentation in English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-onvif/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/guim31/gladys-onvif/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/guim31/gladys-onvif/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/guim31/gladys-onvif/releases/tag/v1.0.0
