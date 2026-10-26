-- Custom fields on a spare (ADR-0074, sign-off r38-stock-how: prices as custom fields). A definition
-- may now apply to `part`, a StockItem in the design. Only the kind list changes: the CHECK 0035
-- wrote inline is named by PostgreSQL's default, `field_definitions_kind_check`.
ALTER TABLE field_definitions DROP CONSTRAINT IF EXISTS field_definitions_kind_check;
ALTER TABLE field_definitions ADD CONSTRAINT field_definitions_kind_check
    CHECK (kind IN ('device', 'rack', 'cable', 'port', 'network', 'part'));
