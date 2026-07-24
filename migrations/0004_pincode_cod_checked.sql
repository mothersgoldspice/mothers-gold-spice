-- `pincode_cache.cod_available` was ambiguous: 0 meant BOTH "the courier will
-- not collect cash here" and "nobody has asked". Since a prepaid quote is the
-- common case and writes 0, the first prepaid lookup for a PIN code poisoned the
-- COD answer for the next three days — and the customer was told, wrongly, that
-- cash on delivery is not available where they live.
--
-- This column records whether the cached row came from a query that actually
-- asked about COD. Only then is `cod_available` meaningful.
ALTER TABLE pincode_cache ADD COLUMN cod_checked INTEGER NOT NULL DEFAULT 0;
