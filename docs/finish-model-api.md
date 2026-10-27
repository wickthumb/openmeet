# Finish-model API: draft contract

This is a design proposal, not a deployed or verified API. Endpoint paths and fields may change during implementation.

## Responsibility

The API proposes finish marks and, where appropriate, lane associations from finish evidence. OpenMeet retains the original hardware timestamps and maps returned image positions back to that evidence. An official controls acceptance of each suggestion and approval of results.

## Proposed inference request

`POST /v1/finish-predictions`

The request should include:

- A client-generated request identifier for retries and tracing.
- The race identifier and race format, such as a laned sprint.
- The finish image or an agreed evidence reference.
- Image dimensions, orientation, and the finish-line coordinate convention.
- Lane geometry or lane assignments when available.
- The requested model version, if the service supports version selection.

Authentication and transport details will be defined when the service is implemented. Never embed service credentials in a client-side bundle or commit them to Git.

## Proposed response

The response should include:

- The echoed request identifier and evidence identifier.
- The model version used for inference.
- A list of proposed image-coordinate finish marks.
- A proposed lane association where supported.
- Confidence or uncertainty information when the model can provide it.
- Warnings about missing evidence or unsupported input.

The response contains predictions, not official approval. The protocol must define coordinate and timestamp mapping explicitly before measured times are produced.

## First implementation decisions

1. Choose the finish-image representation and coordinate convention.
2. Decide how images are transferred and how evidence references are validated.
3. Define synchronous versus asynchronous inference and timeout behavior.
4. Specify error responses, versioning, and retry behavior.
5. Connect proposals to the application's official review flow.
