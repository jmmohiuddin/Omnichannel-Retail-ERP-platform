-- 002_catalog.sql — locations, catalog: categories, brands, products, variants, prices

CREATE TABLE location (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenant(id),
    kind        text NOT NULL CHECK (kind IN ('store','warehouse','virtual')),
    name        text NOT NULL,
    code        text NOT NULL,                  -- short code for receipts/labels
    address     jsonb,
    is_active   boolean NOT NULL DEFAULT true,
    UNIQUE (tenant_id, code)
);
ALTER TABLE device
    ADD CONSTRAINT device_location_fk FOREIGN KEY (location_id) REFERENCES location(id);

CREATE TABLE category (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenant(id),
    parent_id   uuid REFERENCES category(id),
    name        text NOT NULL,
    slug        text NOT NULL,
    position    int NOT NULL DEFAULT 0,
    seo         jsonb NOT NULL DEFAULT '{}',
    UNIQUE (tenant_id, slug)
);

CREATE TABLE brand (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenant(id),
    name        text NOT NULL,
    slug        text NOT NULL,
    UNIQUE (tenant_id, slug)
);

CREATE TABLE supplier (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenant(id),
    name        text NOT NULL,
    contact     jsonb NOT NULL DEFAULT '{}',
    payment_terms text,
    is_active   boolean NOT NULL DEFAULT true
);

CREATE TABLE product (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenant(id),
    category_id  uuid REFERENCES category(id),
    brand_id     uuid REFERENCES brand(id),
    name         text NOT NULL,
    slug         text NOT NULL,
    description  text,
    spec         jsonb NOT NULL DEFAULT '{}',   -- structured specifications
    seo          jsonb NOT NULL DEFAULT '{}',
    tracking     text NOT NULL DEFAULT 'none'
                 CHECK (tracking IN ('none','batch','serialized')), -- phones: serialized
    tax_class    text NOT NULL DEFAULT 'standard',
    status       text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','active','archived')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, slug)
);
CREATE INDEX product_name_trgm_idx ON product USING gin (name gin_trgm_ops);

-- Sellable unit. Simple products have exactly one variant.
CREATE TABLE variant (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES tenant(id),
    product_id   uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    sku          text NOT NULL,
    barcode      text,                          -- EAN/UPC; QR payloads resolve to sku
    attributes   jsonb NOT NULL DEFAULT '{}',   -- {"color":"Black","storage":"256GB"}
    cost_minor   bigint,                        -- last/avg cost, minor units
    price_minor  bigint NOT NULL,               -- base selling price, minor units
    currency     char(3) NOT NULL,
    warranty_months int,
    weight_grams int,
    is_active    boolean NOT NULL DEFAULT true,
    UNIQUE (tenant_id, sku)
);
CREATE INDEX variant_barcode_idx ON variant (tenant_id, barcode) WHERE barcode IS NOT NULL;

CREATE TABLE product_image (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenant(id),
    product_id  uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    variant_id  uuid REFERENCES variant(id) ON DELETE CASCADE,
    url         text NOT NULL,
    alt         text,
    position    int NOT NULL DEFAULT 0
);

-- Price lists: retail/wholesale/channel-specific overrides
CREATE TABLE price_list (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES tenant(id),
    name        text NOT NULL,
    kind        text NOT NULL DEFAULT 'retail'
                CHECK (kind IN ('retail','wholesale','channel','promo')),
    currency    char(3) NOT NULL,
    starts_at   timestamptz,
    ends_at     timestamptz,
    UNIQUE (tenant_id, name)
);

CREATE TABLE price_list_item (
    price_list_id uuid NOT NULL REFERENCES price_list(id) ON DELETE CASCADE,
    tenant_id     uuid NOT NULL REFERENCES tenant(id),
    variant_id    uuid NOT NULL REFERENCES variant(id) ON DELETE CASCADE,
    price_minor   bigint NOT NULL CHECK (price_minor >= 0),
    min_qty       numeric(14,3) NOT NULL DEFAULT 1,
    PRIMARY KEY (price_list_id, variant_id, min_qty)
);

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['location','category','brand','supplier','product','variant',
                             'product_image','price_list','price_list_item']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
          'CREATE POLICY tenant_isolation ON %I
             USING (tenant_id = current_tenant_id())
             WITH CHECK (tenant_id = current_tenant_id())', t);
    END LOOP;
END $$;
