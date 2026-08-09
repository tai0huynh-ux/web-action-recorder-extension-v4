# Third-Party Notices

## CloakBrowser binary

The private Browser Agent image downloads the unmodified CloakBrowser binary
version `146.0.7680.177.5` from the official CloakHQ release channel while the
image is being built. The build verifies the vendor-signed manifest and then
requires this archive SHA-256 before the binary is accepted:

`4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e`

- Binary license: `https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md`
- Reviewed license: CloakBrowser Binary License Version 1.3, July 2026
- Reviewed license SHA-256: `a959b6f9db58f7e273694368659140e9d82960d964ab48b5f6cf9c4545cc2981`
- Wrapper package: `cloakbrowser@0.5.5`, MIT licensed, build stage only

Version 1.3 permits internal use of the unmodified binary in internally
controlled Docker images and artifact repositories. It prohibits redistribution
and third-party browser control without a separate agreement. The binary is not
included in the source repository or Windows release bundle. Subscription or
license entitlement remains an operational prerequisite and is not proven by a
successful checksum or image build.

## xclip-sensitive

The Browser Agent image builds `/usr/local/bin/war-xclip-sensitive` from the
upstream xclip source revision `2c3b811002b35d3be7f39cc1145dd06bdb32e31c`.
The complete upstream source archive is retained in the image at
`/usr/share/doc/war-xclip-sensitive/xclip-2c3b811002b35d3be7f39cc1145dd06bdb32e31c.tar.gz`.

- Source archive: `https://github.com/astrand/xclip/archive/2c3b811002b35d3be7f39cc1145dd06bdb32e31c.tar.gz`
- Verified SHA-256: `2bb193f5ac15872bc1b2579643bebf6303804b98e7b6bcc55ff2be9921843a4a`
- License identifier: `GPL-2.0-or-later`
- Primary license text: `https://raw.githubusercontent.com/astrand/xclip/2c3b811002b35d3be7f39cc1145dd06bdb32e31c/COPYING`

The exact `COPYING` file from that source revision is installed at
`/usr/share/licenses/war-xclip-sensitive/LICENSE`. The upstream C source
headers identify the program as GPL version 2 or later.

The checked-in `SBOM.spdx.json` records only this xclip source provenance. It
is intentionally not represented as the complete image SBOM. After an image
is built, `scripts/ci/generate-image-sbom.mjs` inventories the exact in-image
Debian and npm packages, adds the pinned Node base, CloakBrowser, Node runtime,
and xclip evidence, then emits an SPDX document and SHA-256 sidecar bound to
the immutable local image ID.
