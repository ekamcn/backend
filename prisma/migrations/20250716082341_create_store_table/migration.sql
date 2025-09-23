CREATE TABLE stores (
    store_id CHAR(36) NOT NULL PRIMARY KEY DEFAULT (UUID()),
    store_name TEXT NOT NULL,
    email TEXT NOT NULL,
    store_url TEXT,
    google_ads_id TEXT,
    synchronis_id TEXT,
    shopify_url TEXT,
    custom_offer_ids JSON,
    status TEXT,
    is_published BOOLEAN,
    phone TEXT NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);
