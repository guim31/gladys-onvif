# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes. In
particular:

- the camera accounts: they live in the Gladys configuration (password fields
  are secrets) and reach the container through the SDK; they are sent to the
  cameras only as a WS-Security password digest or an HTTP Digest answer
  (Basic only when a camera offers nothing else), and in the RTSP address
  given to ffmpeg for the cameras without snapshot address. They are never
  written to `/data` nor to the logs;
- `/data/onvif-state.json`: the cameras found (address, port, brand, model,
  serial number, the user name of the account that works, video sources,
  presets, detections). No password;
- the network: HTTP (SOAP) and RTSP to the cameras of the local network, the
  addresses the user typed or the cameras that answered the WS-Discovery probe
  the Gladys core broadcasts; no internet access. Camera certificates are not
  verified on HTTPS addresses (self-signed);
- the XML read from the cameras: document types are refused, no entity is
  expanded, sizes are bounded.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
and the cameras and their firmware.
