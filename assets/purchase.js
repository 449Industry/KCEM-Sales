(() => {
  const cfg = window.KCEM_CONFIG || {};
  const TABLE = "shared_purchase_requests";
  const THIS_SITE = "KCEM";
  const TOKEN_KEY = "kcem_public_access_token";
  const POLL_MS = Math.max(5000, Number(cfg.POLL_INTERVAL_MS || 5000));

  const $ = id => document.getElementById(id);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  const SITE = {
    KCEM: { label: "KCEM", color: "#B9443B" },
    OOZY: { label: "OOZY", color: "#183F23" },
    UWASH: { label: "UWASH", color: "#E1251B" }
  };

  const ALIASES = {
    id: [
      "id", "request_id", "purchase_request_id", "purchase_id",
      "shared_purchase_id", "uuid"
    ],
    source: [
      "source_site", "site", "source", "origin_site", "request_site"
    ],
    status: [
      "status", "request_status", "purchase_status"
    ],
    priority: [
      "priority", "priority_level", "urgency", "priority_no"
    ],
    requestDate: [
      "request_date", "requested_date", "request_day", "requested_at",
      "request_at", "date_requested", "request_dt", "date"
    ],
    content: [
      "item_name", "request_text", "request_content", "item_request",
      "item", "title", "content", "request_item", "description",
      "item_text", "request_name", "purchase_item", "purchase_content",
      "item_content", "request_description", "request_detail",
      "request_details", "item_description", "product_name", "product",
      "name"
    ],
    quantity: [
      "quantity", "qty", "request_quantity", "quantity_text",
      "qty_text", "request_qty", "count", "amount_qty"
    ],
    amount: [
      "expected_amount", "estimated_amount", "expected_price",
      "estimated_price", "estimate_amount", "estimate_price",
      "estimated_cost", "expected_cost", "cost", "price",
      "budget", "amount"
    ],
    memo: [
      "memo", "note", "notes", "comment", "comments", "remarks",
      "remark", "detail_memo", "request_memo", "memo_text"
    ],
    createdAt: [
      "created_at", "created_on", "inserted_at", "created"
    ],
    updatedAt: [
      "updated_at", "local_updated_at", "modified_at", "updated"
    ],
    completedAt: [
      "completed_at", "purchased_at", "done_at", "finished_at"
    ]
  };

  const FALLBACK = {
    id: "id",
    source: "source_site",
    status: "status",
    priority: "priority",
    requestDate: "request_date",
    content: "item_name",
    quantity: "quantity",
    amount: "expected_amount",
    memo: "memo",
    createdAt: "created_at",
    updatedAt: "updated_at",
    completedAt: "completed_at"
  };

  let client = null;
  let rows = [];
  let activeStatus = "pending";
  let pollTimer = null;
  let initialized = false;
  let schemaColumns = new Set();
  let columnMap = { ...FALLBACK };
  let manualPriority = 3;
  let editPriority = 3;

  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[ch]));

  const won = value => {
    if (value == null || value === "") return "-";
    const n = Number(String(value).replace(/[^\d.-]/g, ""));
    if (Number.isFinite(n) && n !== 0) {
      return `${n.toLocaleString("ko-KR")}원`;
    }
    if (Number.isFinite(n) && n === 0) return "-";
    return escapeHtml(String(value));
  };

  function publicToken() {
    return localStorage.getItem(TOKEN_KEY) || "";
  }

  function todayKst() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());

    const out = {};
    parts.forEach(p => {
      if (p.type !== "literal") out[p.type] = p.value;
    });
    return `${out.year}-${out.month}-${out.day}`;
  }

  function formatDate(value) {
    if (!value) return "-";
    const s = String(value).slice(0, 10);
    const p = s.split("-");
    if (p.length === 3) return `${Number(p[1])}/${Number(p[2])}`;
    return s;
  }

  function formatDateTime(value) {
    if (!value) return "-";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "-";
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(d);
  }

  function message(text, isError = false) {
    const el = $("purchaseMessage");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("error", Boolean(isError));
  }

  async function initClient() {
    if (client) return;
    client = window.supabase.createClient(
      cfg.SUPABASE_URL,
      cfg.SUPABASE_PUBLISHABLE_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false
        }
      }
    );
  }

  function chooseColumn(key, columns = schemaColumns) {
    for (const candidate of ALIASES[key] || []) {
      if (columns.has(candidate)) return candidate;
    }
    return FALLBACK[key];
  }

  function applyColumnMap(columns) {
    schemaColumns = new Set(columns || []);
    for (const key of Object.keys(FALLBACK)) {
      columnMap[key] = chooseColumn(key, schemaColumns);
    }
  }

  function looksLikeDate(value) {
    if (value == null) return false;
    const s = String(value);
    return /^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(s);
  }

  function keyScore(key, words) {
    const k = String(key || "").toLowerCase();
    let score = 0;
    for (const word of words) {
      if (k === word) score += 100;
      else if (k.includes(word)) score += 10;
    }
    return score;
  }

  function inferColumnFromRow(row, logicalKey) {
    if (!row || typeof row !== "object") return null;

    const keys = Object.keys(row);
    const excluded = new Set([
      columnMap.id, columnMap.source, columnMap.status, columnMap.priority,
      columnMap.createdAt, columnMap.updatedAt, columnMap.completedAt
    ].filter(Boolean));

    const specs = {
      requestDate: ["request_date", "requested", "request", "date", "day"],
      content: ["item", "request", "content", "title", "product", "name", "description", "text"],
      quantity: ["quantity", "qty", "count", "unit"],
      amount: ["amount", "price", "cost", "estimate", "estimated", "expected", "budget"],
      memo: ["memo", "note", "comment", "remark", "detail"]
    };

    let candidates = keys
      .filter(k => !excluded.has(k))
      .map(k => ({
        key: k,
        value: row[k],
        score: keyScore(k, specs[logicalKey] || [])
      }));

    if (logicalKey === "requestDate") {
      candidates = candidates
        .filter(x => looksLikeDate(x.value))
        .map(x => ({
          ...x,
          score: x.score
            + (/request|requested/i.test(x.key) ? 50 : 0)
            - (/created|updated|completed|finished|done/i.test(x.key) ? 60 : 0)
        }));
    }

    if (logicalKey === "content") {
      candidates = candidates
        .filter(x =>
          typeof x.value === "string" &&
          x.value.trim() &&
          !looksLikeDate(x.value) &&
          !/^(UWASH|OOZY|KCEM|pending|completed)$/i.test(x.value.trim())
        )
        .map(x => ({
          ...x,
          score: x.score
            + Math.min(30, String(x.value).trim().length / 3)
            - (/memo|note|comment|remark/i.test(x.key) ? 40 : 0)
            - (/source|site|status/i.test(x.key) ? 100 : 0)
        }));
    }

    if (logicalKey === "quantity") {
      candidates = candidates
        .filter(x =>
          x.value != null &&
          String(x.value).trim() !== "" &&
          !looksLikeDate(x.value)
        )
        .map(x => ({
          ...x,
          score: x.score
            - (/priority/i.test(x.key) ? 100 : 0)
            - (/amount|price|cost/i.test(x.key) ? 50 : 0)
        }));
    }

    if (logicalKey === "amount") {
      candidates = candidates
        .filter(x =>
          x.value != null &&
          String(x.value).trim() !== "" &&
          !Number.isNaN(Number(String(x.value).replace(/,/g, "")))
        )
        .map(x => ({
          ...x,
          score: x.score
            - (/priority|quantity|qty|count/i.test(x.key) ? 100 : 0)
        }));
    }

    if (logicalKey === "memo") {
      candidates = candidates
        .filter(x =>
          typeof x.value === "string" &&
          x.value.trim() &&
          !looksLikeDate(x.value)
        )
        .map(x => ({
          ...x,
          score: x.score
            - (/item|product|title|content/i.test(x.key) ? 25 : 0)
        }));
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.length && candidates[0].score > 0
      ? candidates[0].key
      : null;
  }

  function improveMapFromRows(data) {
    if (!Array.isArray(data) || !data.length) return;

    const sampleRows = data.slice(0, 10);
    const keys = new Set();
    sampleRows.forEach(row =>
      Object.keys(row || {}).forEach(k => keys.add(k))
    );

    applyColumnMap([...keys]);

    const logicalKeys = ["requestDate", "content", "quantity", "amount", "memo"];

    for (const logicalKey of logicalKeys) {
      const mapped = columnMap[logicalKey];
      const mappedActuallyExists = [...keys].includes(mapped);

      if (!mappedActuallyExists) {
        let best = null;
        const votes = new Map();

        for (const row of sampleRows) {
          const inferred = inferColumnFromRow(row, logicalKey);
          if (inferred) {
            votes.set(inferred, (votes.get(inferred) || 0) + 1);
          }
        }

        if (votes.size) {
          best = [...votes.entries()]
            .sort((a, b) => b[1] - a[1])[0][0];
        }

        if (best) columnMap[logicalKey] = best;
      }
    }

    console.info("[KCEM shared_purchase_requests] detected columns", {
      available: [...keys],
      map: { ...columnMap }
    });
  }

  async function discoverSchema() {
    // v1.7.2부터 브라우저는 shared_purchase_requests에 직접 접근하지 않습니다.
    // 서버 RPC가 실제 컬럼명을 감지해 표준 JSON으로 반환합니다.
    applyColumnMap([
      "id", "source_site", "status", "priority", "request_date",
      "content", "quantity", "expected_amount", "memo",
      "created_at", "updated_at", "completed_at"
    ]);
  }

  function readRaw(row, key) {
    const preferred = columnMap[key];
    if (preferred && row && preferred in row) return row[preferred];

    for (const alias of ALIASES[key] || []) {
      if (row && alias in row) return row[alias];
    }

    if (["requestDate", "content", "quantity", "amount", "memo"].includes(key)) {
      const inferred = inferColumnFromRow(row, key);
      if (inferred && inferred in row) return row[inferred];
    }

    return null;
  }

  function normalize(row) {
    return {
      raw: row,
      id: readRaw(row, "id"),
      source: String(readRaw(row, "source") || "").toUpperCase(),
      status: String(readRaw(row, "status") || "pending").toLowerCase(),
      priority: Math.max(1, Math.min(5, Number(readRaw(row, "priority") || 3))),
      requestDate: readRaw(row, "requestDate") || "",
      content: readRaw(row, "content") || "",
      quantity: readRaw(row, "quantity") ?? "",
      amount: (() => {
        const value = readRaw(row, "amount");
        if (value == null || value === "") return null;
        const parsed = Number(String(value).replace(/[^\d.-]/g, ""));
        return Number.isFinite(parsed) ? parsed : value;
      })(),
      memo: readRaw(row, "memo") || "",
      createdAt: readRaw(row, "createdAt"),
      updatedAt: readRaw(row, "updatedAt"),
      completedAt: readRaw(row, "completedAt")
    };
  }

  function setField(payload, key, value, options = {}) {
    const col = columnMap[key] || FALLBACK[key];
    if (!col) return;
    if (options.skipUnknown && schemaColumns.size && !schemaColumns.has(col)) return;
    payload[col] = value;
  }

  function siteMeta(site) {
    return SITE[site] || { label: site || "-", color: "#777" };
  }

  function parseKoreanAmount(text) {
    const s = String(text || "").replace(/,/g, "");
    let m = s.match(/(\d+(?:\.\d+)?)\s*만원/);
    if (m) return { amount: Math.round(Number(m[1]) * 10000), matched: m[0] };

    m = s.match(/(\d+(?:\.\d+)?)\s*천원/);
    if (m) return { amount: Math.round(Number(m[1]) * 1000), matched: m[0] };

    m = s.match(/(\d{3,})\s*원/);
    if (m) return { amount: Number(m[1]), matched: m[0] };

    return { amount: null, matched: "" };
  }

  function parseNatural(text) {
    let rest = String(text || "").trim();
    let priority = 3;

    let m = rest.match(/(?:우선\s*)?([1-5])\s*순위/i);
    if (m) {
      priority = Number(m[1]);
      rest = rest.replace(m[0], " ");
    } else {
      m = rest.match(/(?:우선|priority)\s*[:=]?\s*([1-5])/i);
      if (m) {
        priority = Number(m[1]);
        rest = rest.replace(m[0], " ");
      }
    }

    const amountInfo = parseKoreanAmount(rest);
    if (amountInfo.matched) rest = rest.replace(amountInfo.matched, " ");

    let quantity = "";
    const q = rest.match(/(\d+(?:\.\d+)?)\s*(개|롤|통|박스|세트|장|봉|팩|병|개입)\b/i);
    if (q) {
      quantity = `${q[1]}${q[2]}`;
      rest = rest.replace(q[0], " ");
    }

    let memo = "";
    const memoWords = [];
    ["급함", "긴급", "가능하면 빨리", "재고없음", "재고 부족"].forEach(word => {
      if (rest.includes(word)) {
        memoWords.push(word);
        rest = rest.replace(word, " ");
      }
    });
    memo = memoWords.join(" / ");

    const content = rest
      .replace(/[|,]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return {
      requestDate: todayKst(),
      priority,
      content: content || String(text || "").trim(),
      quantity,
      amount: amountInfo.amount,
      memo
    };
  }

  function renderQuickPreview() {
    const raw = $("purchaseQuickInput")?.value.trim() || "";
    if (!raw) {
      $("purchaseQuickPreview").classList.add("hidden");
      $("purchaseQuickPreview").innerHTML = "";
      return null;
    }

    const parsed = parseNatural(raw);
    const chips = [
      `<span><em>우선</em>${parsed.priority}순위</span>`,
      `<span><em>내용</em>${escapeHtml(parsed.content)}</span>`
    ];

    if (parsed.quantity) chips.push(`<span><em>수량</em>${escapeHtml(parsed.quantity)}</span>`);
    if (parsed.amount) chips.push(`<span><em>예상</em>${won(parsed.amount)}</span>`);
    if (parsed.memo) chips.push(`<span><em>메모</em>${escapeHtml(parsed.memo)}</span>`);

    $("purchaseQuickPreview").innerHTML = chips.join("");
    $("purchaseQuickPreview").classList.remove("hidden");
    return parsed;
  }

  function currentRows() {
    return rows
      .filter(r => r.status === activeStatus)
      .sort((a, b) => {
        if (activeStatus === "pending") {
          return a.priority - b.priority
            || String(b.requestDate || "").localeCompare(String(a.requestDate || ""))
            || String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
        }
        return String(b.completedAt || b.updatedAt || b.createdAt || "")
          .localeCompare(String(a.completedAt || a.updatedAt || a.createdAt || ""));
      });
  }

  function renderCounts() {
    $("purchasePendingCount").textContent = rows.filter(r => r.status === "pending").length;
    $("purchaseCompletedCount").textContent = rows.filter(r => r.status === "completed").length;
  }

  function actionButtons(row) {
    const own = row.source === THIS_SITE;

    const ownButtons = own
      ? `
        <button type="button" class="purchase-row-btn" data-edit-purchase="${escapeHtml(row.id)}">수정</button>
        <button type="button" class="purchase-row-btn danger-lite" data-delete-purchase="${escapeHtml(row.id)}">삭제</button>
      `
      : "";

    const statusButton = row.status === "completed"
      ? `<button type="button" class="purchase-row-btn" data-reopen-purchase="${escapeHtml(row.id)}">완료취소</button>`
      : `<button type="button" class="purchase-row-btn complete" data-complete-purchase="${escapeHtml(row.id)}">구매완료</button>`;

    return `<div class="purchase-row-actions">${ownButtons}${statusButton}</div>`;
  }

  function render() {
    renderCounts();

    $$(".purchase-tab").forEach(btn =>
      btn.classList.toggle("active", btn.dataset.status === activeStatus)
    );

    const view = currentRows();

    $("purchaseRows").innerHTML = view.map(row => {
      const meta = siteMeta(row.source);
      const completed = row.status === "completed";

      return `
        <tr class="${completed ? "purchase-completed-row" : ""}">
          <td>
            <span class="purchase-source-badge" style="--site-color:${meta.color}">
              ${escapeHtml(meta.label)}
            </span>
          </td>
          <td><span class="priority-badge p${row.priority}">${row.priority}</span></td>
          <td>${formatDate(row.requestDate)}</td>
          <td class="purchase-content-cell"><strong>${escapeHtml(row.content || "-")}</strong></td>
          <td>${escapeHtml(row.quantity || "-")}</td>
          <td class="right">${won(row.amount)}</td>
          <td class="purchase-memo-cell">${escapeHtml(row.memo || "")}</td>
          <td class="center">${actionButtons(row)}</td>
        </tr>
      `;
    }).join("");

    $("purchaseEmpty").classList.toggle("hidden", view.length !== 0);

    $$("[data-edit-purchase]").forEach(btn =>
      btn.addEventListener("click", () => openEdit(btn.dataset.editPurchase))
    );
    $$("[data-delete-purchase]").forEach(btn =>
      btn.addEventListener("click", () => deleteRequest(btn.dataset.deletePurchase))
    );
    $$("[data-complete-purchase]").forEach(btn =>
      btn.addEventListener("click", () => setStatus(btn.dataset.completePurchase, "completed"))
    );
    $$("[data-reopen-purchase]").forEach(btn =>
      btn.addEventListener("click", () => setStatus(btn.dataset.reopenPurchase, "pending"))
    );
  }

  async function loadRows() {
    if (!client) await initClient();

    if (!publicToken()) {
      message("공용 PIN 인증 토큰이 없습니다. 페이지를 새로고침해 다시 인증하세요.", true);
      return;
    }

    try {
      const { data, error } = await client.rpc("kcem_shared_purchase_list", {
        p_token: publicToken()
      });

      if (error) throw error;

      rows = (Array.isArray(data) ? data : []).map(row => ({
        raw: row,
        id: row.id,
        source: String(row.source_site || "").toUpperCase(),
        status: String(row.status || "pending").toLowerCase(),
        priority: Math.max(1, Math.min(5, Number(row.priority || 3))),
        requestDate: row.request_date || "",
        content: row.content || "",
        quantity: row.quantity ?? "",
        amount: (() => {
          const value = row.expected_amount;
          if (value == null || value === "") return null;
          const parsed = Number(String(value).replace(/[^\d.-]/g, ""));
          return Number.isFinite(parsed) ? parsed : value;
        })(),
        memo: row.memo || "",
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
        completedAt: row.completed_at || null
      }));

      render();

      $("purchaseLastUpdated").textContent =
        `마지막 갱신: ${new Intl.DateTimeFormat("ko-KR", {
          timeZone: "Asia/Seoul",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        }).format(new Date())}`;

      message("");
    } catch (error) {
      console.error("shared purchase RPC load error", error);
      const text = String(error?.message || error || "");

      if (text.includes("Could not find the function") || text.includes("PGRST202")) {
        message(
          "공동구매 RPC 설치가 필요합니다. KCEM_SHARED_PURCHASE_RPC_v1.7.2.sql을 Supabase에서 한 번 실행하세요.",
          true
        );
      } else {
        message(`공동 구매요청을 불러오지 못했습니다: ${text}`, true);
      }
    }
  }

  async function insertRequest(values) {
    const { error } = await client.rpc("kcem_shared_purchase_create", {
      p_token: publicToken(),
      p_request_date: values.requestDate,
      p_priority: values.priority,
      p_content: values.content,
      p_quantity: values.quantity || null,
      p_expected_amount: values.amount ?? null,
      p_memo: values.memo || null
    });

    if (error) throw error;
  }

  async function addQuick() {
    const raw = $("purchaseQuickInput").value.trim();
    if (!raw) {
      message("요청 내용을 입력하세요.", true);
      return;
    }

    const parsed = parseNatural(raw);

    $("purchaseQuickAddBtn").disabled = true;
    $("purchaseQuickAddBtn").textContent = "저장 중…";

    try {
      await insertRequest(parsed);
      $("purchaseQuickInput").value = "";
      $("purchaseQuickPreview").classList.add("hidden");
      $("purchaseQuickPreview").innerHTML = "";
      await loadRows();
      $("purchaseQuickInput").focus();
    } catch (error) {
      message(error?.message || "구매요청 등록에 실패했습니다.", true);
    } finally {
      $("purchaseQuickAddBtn").disabled = false;
      $("purchaseQuickAddBtn").textContent = "바로추가";
    }
  }

  function clearManual() {
    $("purchaseRequestDate").value = todayKst();
    manualPriority = 3;
    setPriorityButtons(false);
    $("purchaseContent").value = "";
    $("purchaseQuantity").value = "";
    $("purchaseAmount").value = "";
    $("purchaseMemo").value = "";
  }

  async function addManual() {
    const content = $("purchaseContent").value.trim();
    if (!content) {
      message("품목·요청내용을 입력하세요.", true);
      return;
    }

    const values = {
      requestDate: $("purchaseRequestDate").value || todayKst(),
      priority: manualPriority,
      content,
      quantity: $("purchaseQuantity").value.trim(),
      amount: $("purchaseAmount").value ? Number($("purchaseAmount").value) : null,
      memo: $("purchaseMemo").value.trim()
    };

    $("purchaseManualAddBtn").disabled = true;
    try {
      await insertRequest(values);
      clearManual();
      await loadRows();
    } catch (error) {
      message(error?.message || "구매요청 등록에 실패했습니다.", true);
    } finally {
      $("purchaseManualAddBtn").disabled = false;
    }
  }

  function setPriorityButtons(isEdit) {
    const value = isEdit ? editPriority : manualPriority;
    const attr = isEdit ? "data-edit-priority" : "data-priority";
    $$(`[${attr}]`).forEach(btn => {
      const v = Number(btn.getAttribute(attr));
      btn.classList.toggle("active", v === value);
    });
  }

  function findRow(id) {
    return rows.find(r => String(r.id) === String(id)) || null;
  }

  function openEdit(id) {
    const row = findRow(id);
    if (!row || row.source !== THIS_SITE) return;

    $("purchaseEditId").value = row.id;
    $("purchaseEditDate").value = String(row.requestDate || "").slice(0, 10);
    $("purchaseEditContent").value = row.content || "";
    $("purchaseEditQuantity").value = row.quantity || "";
    $("purchaseEditAmount").value = row.amount ?? "";
    $("purchaseEditMemo").value = row.memo || "";
    editPriority = row.priority || 3;
    setPriorityButtons(true);
    $("purchaseEditMessage").textContent = "";
    $("purchaseEditOverlay").classList.remove("hidden");
  }

  function closeEdit() {
    $("purchaseEditOverlay").classList.add("hidden");
  }

  async function saveEdit() {
    const id = $("purchaseEditId").value;
    const row = findRow(id);
    if (!row || row.source !== THIS_SITE) return;

    const content = $("purchaseEditContent").value.trim();
    if (!content) {
      $("purchaseEditMessage").textContent = "품목·요청내용을 입력하세요.";
      return;
    }

    try {
      $("purchaseEditSave").disabled = true;

      const { error } = await client.rpc("kcem_shared_purchase_update", {
        p_token: publicToken(),
        p_id: String(row.id),
        p_request_date: $("purchaseEditDate").value || todayKst(),
        p_priority: editPriority,
        p_content: content,
        p_quantity: $("purchaseEditQuantity").value.trim() || null,
        p_expected_amount: $("purchaseEditAmount").value
          ? Number($("purchaseEditAmount").value)
          : null,
        p_memo: $("purchaseEditMemo").value.trim() || null
      });

      if (error) throw error;

      closeEdit();
      await loadRows();
    } catch (error) {
      $("purchaseEditMessage").textContent =
        error?.message || "수정에 실패했습니다.";
    } finally {
      $("purchaseEditSave").disabled = false;
    }
  }

  async function deleteRequest(id) {
    const row = findRow(id);
    if (!row || row.source !== THIS_SITE) return;

    if (!confirm(`'${row.content}' 요청을 삭제할까요?`)) return;

    try {
      const { error } = await client.rpc("kcem_shared_purchase_delete", {
        p_token: publicToken(),
        p_id: String(row.id)
      });

      if (error) throw error;
      closeEdit();
      await loadRows();
    } catch (error) {
      message(error?.message || "삭제에 실패했습니다.", true);
    }
  }

  async function setStatus(id, nextStatus) {
    const row = findRow(id);
    if (!row) return;

    try {
      const { error } = await client.rpc("kcem_shared_purchase_set_status", {
        p_token: publicToken(),
        p_id: String(row.id),
        p_status: nextStatus
      });

      if (error) throw error;
      await loadRows();
    } catch (error) {
      message(
        `${nextStatus === "completed" ? "구매완료" : "완료취소"} 처리에 실패했습니다: ${error?.message || error}`,
        true
      );
    }
  }

  function bind() {
    $("purchaseManualToggle").addEventListener("click", () => {
      $("purchaseManualPanel").classList.toggle("hidden");
    });

    $("purchaseRefreshBtn").addEventListener("click", loadRows);

    $("purchaseQuickInput").addEventListener("input", renderQuickPreview);
    $("purchaseQuickInput").addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        addQuick();
      }
    });
    $("purchaseQuickAddBtn").addEventListener("click", addQuick);

    $$("[data-priority]").forEach(btn => {
      btn.addEventListener("click", () => {
        manualPriority = Number(btn.dataset.priority);
        setPriorityButtons(false);
      });
    });

    $$("[data-edit-priority]").forEach(btn => {
      btn.addEventListener("click", () => {
        editPriority = Number(btn.dataset.editPriority);
        setPriorityButtons(true);
      });
    });

    $("purchaseManualClearBtn").addEventListener("click", clearManual);
    $("purchaseManualAddBtn").addEventListener("click", addManual);

    $$(".purchase-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        activeStatus = btn.dataset.status;
        render();
      });
    });

    $("purchaseEditForm").addEventListener("submit", event => {
      event.preventDefault();
      saveEdit();
    });
    $("purchaseEditClose").addEventListener("click", closeEdit);
    $("purchaseEditCancel").addEventListener("click", closeEdit);
    $("purchaseDeleteBtn").addEventListener("click", () =>
      deleteRequest($("purchaseEditId").value)
    );
  }

  async function initialize() {
    if (initialized) return;
    initialized = true;
    await initClient();
    bind();
    clearManual();
    await discoverSchema();
  }

  async function activate() {
    await initialize();
    await loadRows();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!document.hidden && !$("purchaseApp").classList.contains("hidden")) {
        loadRows();
      }
    }, POLL_MS);
  }

  function deactivate() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  window.KCEM_PURCHASE = {
    activate,
    deactivate
  };
})();
