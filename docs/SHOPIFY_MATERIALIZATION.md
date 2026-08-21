# Shopify materialization and revisions

The current Shopify intake writes each order revision into a private staging directory under the
configured inbox. Downloads, JPEG conversion, and `objednavka.json` creation finish there. The
staged directory is validated for the exact expected photo set before it can become active.

On Windows, promotion moves an existing active directory to a uniquely named backup, renames the
validated staging directory into place, and then removes the backup. If promotion fails, the backup
is restored. Fetch, conversion, or validation failures remove temporary directories and leave the
previous active directory untouched. Order IDs accept numeric Shopify IDs and numeric `-` suffixes
only; resolved paths must remain direct children of the inbox.

Every normalized job has a SHA-256 source fingerprint over its order ID, ordered normalized photo
URLs, product and variant data, layout, relevant non-internal attributes, dedication, and expected
photo count. The digest reveals none of those source values. `updatedAt` is stored beside the digest
as revision metadata but is not part of the identity.

Completed autopilot entries store the fingerprint. The same fingerprint remains handled even when
Shopify changes `updatedAt`. A different fingerprint on a completed order is reported for manual
review and is not materialized automatically, preventing an unattended overwrite of production
files. Pre-fingerprint handled entries remain handled conservatively for backwards compatibility.
