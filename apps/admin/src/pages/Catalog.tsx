import { useEffect, useState, type FormEvent } from "react";
import {
  createProduct,
  createVariant,
  listProducts,
  type ProductDto,
  type Tracking,
} from "../lib/api.js";
import { accessToken } from "../lib/auth.js";
import { API_BASE } from "../lib/config.js";
import { decimalToMinor, formatMinor } from "../lib/money.js";
import { useAsync } from "../lib/useAsync.js";
import { useT } from "../lib/useT.js";

/** Server-authored translation overlays, keyed by ISO-639 language code. */
export interface ProductTranslationsMap {
  [lang: string]: { name?: string; description?: string } | undefined;
}

/**
 * Read the Arabic overlay off a product row without leaking `any`. The API
 * returns `translations` as `{}` for legacy rows, so this returns partial
 * strings that the form pre-fills with.
 */
export function readArabicOverlay(
  translations: ProductTranslationsMap | undefined,
): { name: string; description: string } {
  const ar = translations?.ar ?? {};
  return { name: ar.name ?? "", description: ar.description ?? "" };
}

async function saveProductTranslations(
  productId: string,
  lang: string,
  patch: { name?: string; description?: string },
): Promise<ProductTranslationsMap> {
  const token = accessToken();
  const res = await fetch(
    `${API_BASE}/v1/products/${encodeURIComponent(productId)}/translations`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ lang, ...patch }),
    },
  );
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      msg = body.message ?? body.error ?? msg;
    } catch {
      /* non-JSON body */
    }
    throw new Error(msg);
  }
  const body = (await res.json()) as { translations: ProductTranslationsMap };
  return body.translations ?? {};
}

function CreateProductForm({ onCreated }: { onCreated: () => void }) {
  const { t, tEnum } = useT();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [tracking, setTracking] = useState<Tracking>("none");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function slugify(v: string) {
    return v
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createProduct({ name: name.trim(), slug: slug.trim(), tracking });
      setName("");
      setSlug("");
      setSlugTouched(false);
      setTracking("none");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("catalog.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>{t("catalog.newProduct")}</h2>
      {error && <div className="error-banner">{error}</div>}
      <form className="panel" onSubmit={onSubmit}>
        <div className="field" style={{ flex: 2 }}>
          <label htmlFor="np-name">{t("catalog.name")}</label>
          <input
            id="np-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugTouched) setSlug(slugify(e.target.value));
            }}
            placeholder="iPhone 15"
            required
          />
        </div>
        <div className="field" style={{ flex: 2 }}>
          <label htmlFor="np-slug">{t("catalog.slug")}</label>
          <input
            id="np-slug"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
            pattern="[a-z0-9-]+"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="np-tracking">{t("catalog.tracking")}</label>
          <select
            id="np-tracking"
            value={tracking}
            onChange={(e) => setTracking(e.target.value as Tracking)}
          >
            <option value="none">{tEnum("tracking", "none")}</option>
            <option value="batch">{tEnum("tracking", "batch")}</option>
            <option value="serialized">{tEnum("tracking", "serialized")}</option>
          </select>
        </div>
        <button type="submit" disabled={busy}>
          {busy ? t("catalog.creating") : t("catalog.create")}
        </button>
      </form>
    </section>
  );
}

function AddVariantForm({ productId, onCreated }: { productId: string; onCreated: () => void }) {
  const { t } = useT();
  const [sku, setSku] = useState("");
  const [price, setPrice] = useState("");
  const [barcode, setBarcode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const priceMinor = decimalToMinor(price);
    if (priceMinor === null) {
      setError(t("catalog.priceInvalid"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createVariant(productId, {
        sku: sku.trim(),
        priceMinor,
        currency: "AED",
        ...(barcode.trim() ? { barcode: barcode.trim() } : {}),
      });
      setSku("");
      setPrice("");
      setBarcode("");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("catalog.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <div className="error-banner">{error}</div>}
      <form className="panel" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor={`sku-${productId}`}>{t("th.sku")}</label>
          <input
            id={`sku-${productId}`}
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="IPH15-128-BLK"
            required
          />
        </div>
        <div className="field">
          <label htmlFor={`price-${productId}`}>{t("catalog.priceAed")}</label>
          <input
            id={`price-${productId}`}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="decimal"
            placeholder="1299.00"
            required
          />
        </div>
        <div className="field">
          <label htmlFor={`barcode-${productId}`}>{t("catalog.barcodeOptional")}</label>
          <input
            id={`barcode-${productId}`}
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
          />
        </div>
        <button type="submit" disabled={busy}>
          {busy ? t("catalog.adding") : t("catalog.addVariant")}
        </button>
      </form>
    </>
  );
}

function ArabicContentForm({
  product,
  onSaved,
}: {
  product: ProductDto;
  onSaved: () => void;
}) {
  const { t } = useT();
  const initial = readArabicOverlay(
    (product as ProductDto & { translations?: ProductTranslationsMap }).translations,
  );
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset when the row (or its translations) changes underneath us — the
  // parent re-fetches after a save and we want to reflect what the server
  // now has, not the pre-save draft.
  useEffect(() => {
    setName(initial.name);
    setDescription(initial.description);
    setSaved(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id, initial.name, initial.description]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // Only send fields the operator actually filled in; empty inputs mean
      // "keep the English fallback" and shouldn't overwrite an existing
      // translation with an empty string.
      const patch: { name?: string; description?: string } = {};
      const trimmedName = name.trim();
      const trimmedDescription = description.trim();
      if (trimmedName.length > 0) patch.name = trimmedName;
      if (trimmedDescription.length > 0) patch.description = trimmedDescription;
      if (patch.name === undefined && patch.description === undefined) {
        setError(t("catalog.translations.failed"));
        setBusy(false);
        return;
      }
      await saveProductTranslations(product.id, "ar", patch);
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("catalog.translations.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="variants" style={{ marginBlockStart: "var(--space-3)" }}>
      <summary>{t("catalog.translations.title")}</summary>
      <div className="sub-table">
        <p className="subtle">{t("catalog.translations.hint")}</p>
        {error && <div className="error-banner">{error}</div>}
        {saved && !error && <p className="subtle">{t("catalog.translations.saved")}</p>}
        <form className="panel" onSubmit={onSubmit}>
          <div className="field" style={{ flex: 2 }}>
            <label htmlFor={`ar-name-${product.id}`}>{t("catalog.translations.arName")}</label>
            <input
              id={`ar-name-${product.id}`}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSaved(false);
              }}
              dir="rtl"
              lang="ar"
              placeholder="اسم المنتج"
            />
          </div>
          <div className="field" style={{ flex: 3 }}>
            <label htmlFor={`ar-desc-${product.id}`}>
              {t("catalog.translations.arDescription")}
            </label>
            <textarea
              id={`ar-desc-${product.id}`}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                setSaved(false);
              }}
              dir="rtl"
              lang="ar"
              rows={3}
            />
          </div>
          <button type="submit" disabled={busy}>
            {busy ? t("catalog.translations.saving") : t("catalog.translations.save")}
          </button>
        </form>
      </div>
    </details>
  );
}

function ProductRow({ product, onChanged }: { product: ProductDto; onChanged: () => void }) {
  const { t, tEnum } = useT();
  return (
    <div className="card">
      <div className="page-head" style={{ marginBlockEnd: 0 }}>
        <div>
          <strong>{product.name}</strong>{" "}
          <span className="faint mono">/{product.slug}</span>
        </div>
        <div>
          <span className="badge neutral">{tEnum("tracking", product.tracking)}</span>{" "}
          <span className={`badge ${product.status === "active" ? "in" : "neutral"}`}>
            {tEnum("pstatus", product.status)}
          </span>
        </div>
      </div>
      <details className="variants">
        <summary>
          {product.variants.length === 1
            ? t("catalog.variantOne")
            : t("catalog.variantMany", { count: product.variants.length })}
        </summary>
        <div className="sub-table">
          {product.variants.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t("th.sku")}</th>
                    <th>{t("th.barcode")}</th>
                    <th className="num">{t("th.price")}</th>
                  </tr>
                </thead>
                <tbody>
                  {product.variants.map((v) => (
                    <tr key={v.id}>
                      <td className="mono">{v.sku}</td>
                      <td className="mono">{v.barcode ?? "—"}</td>
                      <td className="num">{formatMinor(v.priceMinor, v.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ marginBlockStart: "var(--space-3)" }}>
            <AddVariantForm productId={product.id} onCreated={onChanged} />
          </div>
        </div>
      </details>
      <ArabicContentForm product={product} onSaved={onChanged} />
    </div>
  );
}

export function CatalogPage() {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const { data: products, error, loading, reload } = useAsync(
    () => listProducts(submitted),
    [submitted],
  );

  return (
    <>
      <div className="page-head">
        <h1>{t("nav.catalog")}</h1>
        <span className="subtle">
          {products ? t("catalog.countProducts", { count: products.length }) : ""}
        </span>
      </div>

      <CreateProductForm onCreated={reload} />

      <div className="toolbar" style={{ marginBlockStart: "var(--space-4)" }}>
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(query.trim());
          }}
        >
          <div className="field" style={{ minInlineSize: 260 }}>
            <label htmlFor="catalog-search">{t("catalog.searchLabel")}</label>
            <input
              id="catalog-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("catalog.searchPlaceholder")}
            />
          </div>
          <button type="submit" className="secondary">
            {t("common.search")}
          </button>
        </form>
      </div>

      {error && <div className="error-banner">{t("catalog.loadFailed", { error })}</div>}
      {loading ? (
        <p className="empty">{t("catalog.loading")}</p>
      ) : products && products.length === 0 ? (
        <p className="empty">
          {submitted
            ? t("catalog.noProductsMatching", { query: submitted })
            : t("catalog.noProducts")}
        </p>
      ) : (
        <div className="stack">
          {products?.map((p) => <ProductRow key={p.id} product={p} onChanged={reload} />)}
        </div>
      )}
    </>
  );
}
