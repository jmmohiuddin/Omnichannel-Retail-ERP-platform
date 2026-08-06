import { useState, type FormEvent } from "react";
import {
  createProduct,
  createVariant,
  listProducts,
  type ProductDto,
  type Tracking,
} from "../lib/api.js";
import { decimalToMinor, formatMinor } from "../lib/money.js";
import { useAsync } from "../lib/useAsync.js";

function CreateProductForm({ onCreated }: { onCreated: () => void }) {
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
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>New product</h2>
      {error && <div className="error-banner">{error}</div>}
      <form className="panel" onSubmit={onSubmit}>
        <div className="field" style={{ flex: 2 }}>
          <label htmlFor="np-name">Name</label>
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
          <label htmlFor="np-slug">Slug</label>
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
          <label htmlFor="np-tracking">Tracking</label>
          <select
            id="np-tracking"
            value={tracking}
            onChange={(e) => setTracking(e.target.value as Tracking)}
          >
            <option value="none">None</option>
            <option value="batch">Batch</option>
            <option value="serialized">Serialized (IMEI)</option>
          </select>
        </div>
        <button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create product"}
        </button>
      </form>
    </section>
  );
}

function AddVariantForm({ productId, onCreated }: { productId: string; onCreated: () => void }) {
  const [sku, setSku] = useState("");
  const [price, setPrice] = useState("");
  const [barcode, setBarcode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const priceMinor = decimalToMinor(price);
    if (priceMinor === null) {
      setError("Price must be a positive AED amount with up to 2 decimals, e.g. 1299.00");
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
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <div className="error-banner">{error}</div>}
      <form className="panel" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor={`sku-${productId}`}>SKU</label>
          <input
            id={`sku-${productId}`}
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="IPH15-128-BLK"
            required
          />
        </div>
        <div className="field">
          <label htmlFor={`price-${productId}`}>Price (AED)</label>
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
          <label htmlFor={`barcode-${productId}`}>Barcode (optional)</label>
          <input
            id={`barcode-${productId}`}
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
          />
        </div>
        <button type="submit" disabled={busy}>
          {busy ? "Adding…" : "Add variant"}
        </button>
      </form>
    </>
  );
}

function ProductRow({ product, onChanged }: { product: ProductDto; onChanged: () => void }) {
  return (
    <div className="card">
      <div className="page-head" style={{ marginBlockEnd: 0 }}>
        <div>
          <strong>{product.name}</strong>{" "}
          <span className="faint mono">/{product.slug}</span>
        </div>
        <div>
          <span className="badge neutral">{product.tracking}</span>{" "}
          <span className={`badge ${product.status === "active" ? "in" : "neutral"}`}>
            {product.status}
          </span>
        </div>
      </div>
      <details className="variants">
        <summary>
          {product.variants.length} variant{product.variants.length === 1 ? "" : "s"}
        </summary>
        <div className="sub-table">
          {product.variants.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Barcode</th>
                    <th className="num">Price</th>
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
    </div>
  );
}

export function CatalogPage() {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const { data: products, error, loading, reload } = useAsync(
    () => listProducts(submitted),
    [submitted],
  );

  return (
    <>
      <div className="page-head">
        <h1>Catalog</h1>
        <span className="subtle">{products ? `${products.length} products` : ""}</span>
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
            <label htmlFor="catalog-search">Search products</label>
            <input
              id="catalog-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name or slug…"
            />
          </div>
          <button type="submit" className="secondary">
            Search
          </button>
        </form>
      </div>

      {error && <div className="error-banner">Failed to load products: {error}</div>}
      {loading ? (
        <p className="empty">Loading catalog…</p>
      ) : products && products.length === 0 ? (
        <p className="empty">No products{submitted ? ` matching “${submitted}”` : " yet"}.</p>
      ) : (
        <div className="stack">
          {products?.map((p) => <ProductRow key={p.id} product={p} onChanged={reload} />)}
        </div>
      )}
    </>
  );
}
