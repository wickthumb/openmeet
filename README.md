# OpenMeet

Open-source track-and-field timing and meet operations, with AI assistance and officials in control.

OpenMeet is a Track Tools Pro LLC project. The goal is to make finish review, runner identification, and results handling easier to operate so meets can keep moving.

**Status:** working Electron prototype for Windows, macOS and Linux. Run simulated camera captures, review and correct finish marks, exchange start lists and results through a meet folder, and display live scoreboards. Real camera integration and interoperability with AthleticLOCAL still require meet-day validation. The bundled timing stand-in echoes simulator truth; it is labelled in the interface and does not demonstrate model accuracy.

## Run the meet

1. Load the meet manager's start lists through a shared folder.
2. Capture the race and inspect live suggested finishes, or mark them by hand.
3. Correct marks, athlete statuses or the selected start trigger.
4. Save results and move to the next heat.
5. Present the live race and results on a customizable scoreboard.

Camera setup keeps finish locations and per-heat timing sources separate from the view on screen. During replay capture, every registered line-scan records at its native height and sampling rate; earlier races retain their setup snapshots.

The camera clock supplies measurements. Suggested marks require operator review. Start-trigger history and original captured columns are retained when timing is corrected. See the [working demo walkthrough](docs/demo-script.md) for an honest tour of the prototype and its current limits.

## Open app, proprietary model API

The OpenMeet application, integration code, and documentation in this repository are open source under the MIT license.

Timing, cropping and other proprietary models run as separate services. This repository contains their API contracts and client adapters, plus labelled demo stand-ins. Model weights, inference implementations, training code and datasets are excluded from source releases and installers. Connecting a private service does not distribute that service. Access has separate terms.

The Meta agent and the custom finish model have different roles: the custom model proposes finish marks; the Meta agent helps reconcile runner identities and coordinate the review workflow.

## Project documents

- [v1 design blueprint: running the meet](docs/blueprint.md) and its [clickable layout replica](docs/mockup/index.html)
- [Architecture and authority boundaries](docs/architecture.md)
- [Draft finish-model API contract](docs/finish-model-api.md)
- [First prototype roadmap](docs/roadmap.md)
- [Three-minute demo script](docs/demo-script.md)
- [Line-scan billboards: text, logos and AI artwork](docs/billboard-v1.md)

## Development setup

Requires Node 22.2 or newer. The application uses Electron and a separate Node engine process.

```sh
npm --prefix app ci
npm --prefix app start
```

See [desktop setup and installers](app/README.md) and the [design blueprint](docs/blueprint.md). The demo inputs are provided separately.

```sh
npm --prefix engine test
node scripts/check-public-boundary.mjs
```

When configuration is needed, copy `.env.example` to a local `.env` and supply your own values. Keep provider credentials in the backend or local service configuration, outside browser bundles and source control.

Record which components and features are implemented as development progresses. The proposed demo describes the target prototype, rather than completed functionality.

## License

See [LICENSE](LICENSE) for the OpenMeet repository's MIT license. The separate proprietary inference service and model are outside the materials distributed under that license.
