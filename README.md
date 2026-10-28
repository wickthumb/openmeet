# OpenMeet

Open-source track-and-field timing and meet operations, with AI assistance and officials in control.

OpenMeet is a Track Tools Pro LLC project. The goal is to make finish review, runner identification, and results handling easier to operate so meets can keep moving.

**Status:** early development. This initial repository contains the architecture, roadmap, configuration template, and proposed demo. A trained finish-detection model and a working end-to-end application have not been implemented here yet.

## Planned workflow

1. Load the race entries and finish evidence with its hardware timestamps.
2. Call our proprietary vision model through an API to propose sprint finish marks and lane associations.
3. Use a Meta-powered agent to gather bib evidence, check the race roster, and suggest distance-runner identities.
4. Let an official inspect, correct, or leave suggestions unresolved.
5. Produce approved results with their supporting evidence and decision history.

Hardware timestamps provide the measurement foundation. Model predictions are proposals. Officials control approval.

## Open app, proprietary model API

The OpenMeet application, integration code, and documentation in this repository are open source under the MIT license.

The custom finish-detection model is a separate, planned proprietary service. OpenMeet will call its inference API; its weights remain on the service's infrastructure. The model weights, training implementation, and training data are not distributed by this repository. Access to that service will have separate terms.

The Meta agent and the custom finish model have different roles: the custom model proposes finish marks; the Meta agent helps reconcile runner identities and coordinate the review workflow.

## Project documents

- [v1 design blueprint: running the meet](docs/blueprint.md) and its [clickable layout replica](docs/mockup/index.html)
- [Architecture and authority boundaries](docs/architecture.md)
- [Draft finish-model API contract](docs/finish-model-api.md)
- [First prototype roadmap](docs/roadmap.md)
- [Three-minute demo script](docs/demo-script.md)

## Development setup

The runtime and implementation stack are still to be selected. There is no application installation or run command yet.

When configuration is needed, copy `.env.example` to a local `.env` and supply your own values. Keep provider credentials in the backend or local service configuration, outside browser bundles and source control.

Record which components and features are implemented as development progresses. The proposed demo describes the target prototype, rather than completed functionality.

## License

See [LICENSE](LICENSE) for the OpenMeet repository's MIT license. The separate proprietary inference service and model are outside the materials distributed under that license.
