# `@hacc/provider-sdk`

The smallest supported boundary between HACC and a realtime speech provider.

`defineRealtimeProvider` validates and snapshots provider metadata. It is inert:
it never auto-registers the adapter, reads credentials, calls `connect`, or opens
a network connection. A host explicitly passes provider-specific context to
`connect`, so credential custody and transport construction stay visible at the
application boundary.

Adapters translate vendor events into the normalized session contract and
implement audio, text, tool-result, interruption, and close operations. They do
not decide which tools are authorized or whether a consequential effect is safe.
