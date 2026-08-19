# Management close finalization boundary

This action finalizes a management-accounting delivery for the current authorized entity, period, and work scope. A case/workspace object is optional and is used only when the mounted work store provides one. This is not statutory accounting execution.

The finalization receipt must bind:

- entity and optional case/workspace reference when one exists;
- accounting period;
- service scope;
- approved package version;
- reviewer decision reference;
- resulting delivery reference and version;
- remaining open items or exclusions.

An approval is usable only when the host or mounted capability verifies the reviewer and returns a decision matching the same entity, period, scope, and package version, plus the same case/workspace when one exists.

Never upgrade a draft, attempted call, generated document, upload receipt, customer statement, or stale approval into a finalized state.
