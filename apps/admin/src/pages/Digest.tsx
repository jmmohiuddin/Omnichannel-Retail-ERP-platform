import { getDailyDigest } from "../lib/api.js";
import { digestErrorMessage } from "../lib/digest.js";
import { useAsync } from "../lib/useAsync.js";
import { useT } from "../lib/useT.js";

export function DigestPage() {
  const { t, lang } = useT();
  const { data, error, loading, reload } = useAsync(async () => {
    try {
      return await getDailyDigest();
    } catch (err) {
      throw new Error(digestErrorMessage(err, lang));
    }
  }, [lang]);

  return (
    <>
      <div className="page-head">
        <h1>{t("digest.title")}</h1>
        <div className="actions">
          {data &&
            (data.generatedBy === "claude" ? (
              <span className="badge in">{t("digest.byClaude")}</span>
            ) : (
              <span className="badge neutral">{t("digest.stub")}</span>
            ))}
          <button type="button" className="secondary" onClick={reload} disabled={loading}>
            {t("common.refresh")}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading ? (
        <p className="empty">{t("digest.preparing")}</p>
      ) : (
        data && (
          <section className="card">
            <div className="digest-text">{data.digest}</div>
            <details style={{ marginBlockStart: "var(--space-4)" }}>
              <summary className="faint">{t("digest.rawData")}</summary>
              <pre className="mono raw-json">{JSON.stringify(data.data, null, 2)}</pre>
            </details>
          </section>
        )
      )}
    </>
  );
}
