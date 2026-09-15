(() => {
  const cfg = window.KCEM_CONFIG || {};
  const TABLE = "shared_purchase_requests";
  const THIS_SITE = "KCEM";
  const POLL_MS = Math.max(5000, Number(cfg.POLL_INTERVAL_MS || 5000));

  const $ = id => document.getElementById(id);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  const SITE = {
    KCEM: { label: "KCEM", color: "#B9443B" },
    OOZY: { label: "OOZY", color: "#183F23" },
    UWASH: { label: "UWASH", color: "#E1251B" }
  };

  const ALIASES = {
    id: ["id", "request_id", "purchase_request_id", "uuid"],
    source: ["source_site"],
    status: ["status"],
    priority: ["priority"],
    requestDate: ["request_date", "requested_date", "request_day", "date"],
    content: [
      "item_name", "request_text", "request_content", "item_request",
      "item", "title", "content", "request_item", "description"
    ],
    quantity: ["quantity", "qty", "request_quantity"],
    amount: ["expected_amount", "estimated_amount", "expected_price", "amount", "budget"],
    memo: ["memo", "note", "notes", "comment", "remarks"],
    createdAt: ["created_at"],
    updatedAt: ["updated_at"],
    completedAt: ["completed_at"]
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
    const n = Number(value || 0);
    return n ? `${n.toLocaleString("ko-KR")}원` : "-";
  };

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

  async function discoverSchema() {
    try {
      const res = await fetch(`${cfg.SUPABASE_URL}/rest/v1/`, {
        headers: {
          apikey: cfg.SUPABASE_PUBLISHABLE_KEY,
          Accept: "application/openapi+json"
        }
      });

      if (res.ok) {
        const spec = await res.json();
        const props =
          spec?.definitions?.[TABLE]?.properties ||
          spec?.components?.schemas?.[TABLE]?.properties ||
          null;

        if (props) {
          applyColumnMap(Object.keys(props));
          return;
        }
      }
    } catch (_) {}

    try {
      const { data } = await client.from(TABLE).select("*").limit(1);
      if (Array.isArray(data) && data[0]) {
        applyColumnMap(Object.keys(data[0]));
      }
    } catch (_) {}
  }

  function readRaw(row, key) {
    const preferred = columnMap[key];
    if (preferred && row && preferred in row) return row[preferred];

    for (const alias of ALIASES[key] || []) {
      if (row && alias in row) return row[alias];
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
      amount: readRaw(row, "amount") ?? null,
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

    try {
      const { data, error } = await client.from(TABLE).select("*");
      if (error) throw error;

      if ((!schemaColumns.size) && Array.isArray(data) && data[0]) {
        applyColumnMap(Object.keys(data[0]));
      }

      rows = (Array.isArray(data) ? data : []).map(normalize);
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
      console.error("shared purchase load error", error);
      message(
        `공동 구매요청을 불러오지 못했습니다: ${error?.message || error}`,
        true
      );
    }
  }

  async function insertRequest(values) {
    const payload = {};
    setField(payload, "source", THIS_SITE);
    setField(payload, "status", "pending");
    setField(payload, "priority", values.priority);
    setField(payload, "requestDate", values.requestDate);
    setField(payload, "content", values.content);
    setField(payload, "quantity", values.quantity || null, { skipUnknown: true });
    setField(payload, "amount", values.amount ?? null, { skipUnknown: true });
    setField(payload, "memo", values.memo || null, { skipUnknown: true });

    const { error } = await client.from(TABLE).insert(payload);
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

    const payload = {};
    setField(payload, "requestDate", $("purchaseEditDate").value || todayKst());
    setField(payload, "priority", editPriority);
    setField(payload, "content", content);
    setField(payload, "quantity", $("purchaseEditQuantity").value.trim() || null, { skipUnknown: true });
    setField(
      payload,
      "amount",
      $("purchaseEditAmount").value ? Number($("purchaseEditAmount").value) : null,
      { skipUnknown: true }
    );
    setField(payload, "memo", $("purchaseEditMemo").value.trim() || null, { skipUnknown: true });

    try {
      $("purchaseEditSave").disabled = true;

      const idCol = columnMap.id || FALLBACK.id;
      const { error } = await client
        .from(TABLE)
        .update(payload)
        .eq(idCol, row.id)
        .eq(columnMap.source || FALLBACK.source, THIS_SITE);

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
      const { error } = await client
        .from(TABLE)
        .delete()
        .eq(columnMap.id || FALLBACK.id, row.id)
        .eq(columnMap.source || FALLBACK.source, THIS_SITE);

      if (error) throw error;
      await loadRows();
    } catch (error) {
      message(error?.message || "삭제에 실패했습니다.", true);
    }
  }

  async function setStatus(id, nextStatus) {
    const row = findRow(id);
    if (!row) return;

    const payload = {};
    setField(payload, "status", nextStatus);

    if (columnMap.completedAt && (!schemaColumns.size || schemaColumns.has(columnMap.completedAt))) {
      payload[columnMap.completedAt] =
        nextStatus === "completed" ? new Date().toISOString() : null;
    }

    try {
      const { error } = await client
        .from(TABLE)
        .update(payload)
        .eq(columnMap.id || FALLBACK.id, row.id);

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
