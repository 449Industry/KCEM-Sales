(() => {
  const cfg = window.KCEM_CONFIG || {};
  const $ = id => document.getElementById(id);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  const TOKEN_KEY = "kcem_public_access_token";
  const MODULE_KEY = "kcem_current_module";
  const FILTER_KEY = "kcem_task_filters_v150";

  let client = null;
  let allMembers = [];
  let activeMembers = [];
  let tasks = [];
  let selectedMemberId = "ALL";
  let pollTimer = null;
  let taskApiReady = true;

  const filterState = {
    search: "",
    status: "ALL",
    category: "ALL",
    group: "STATUS",
    sort: "NEWEST"
  };

  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[ch]));

  function token() {
    return localStorage.getItem(TOKEN_KEY) || "";
  }

  function setModule(module) {
    const isTasks = module === "tasks";
    $("salesApp").classList.toggle("hidden", isTasks);
    $("taskApp").classList.toggle("hidden", !isTasks);
    $$(".module-tab").forEach(btn =>
      btn.classList.toggle("active", btn.dataset.module === module)
    );

    localStorage.setItem(MODULE_KEY, module);

    if (isTasks) {
      loadAll();
      startPolling();
    } else {
      stopPolling();
    }
  }

  function rpcErrorText(error) {
    const text = [error?.message, error?.details, error?.hint, error?.code]
      .filter(Boolean).join(" / ");

    if (text.includes("Could not find the function") || text.includes("PGRST202")) {
      taskApiReady = false;
      $("taskSetupNotice").classList.remove("hidden");
      return "업무공유 DB 설정 SQL을 먼저 실행하세요.";
    }

    if (text.includes("인증이 만료") || text.includes("인증이 필요")) {
      return "공용 PIN 인증이 필요합니다. 페이지를 새로고침해 PIN을 입력하세요.";
    }

    return text || "업무 처리 중 오류가 발생했습니다.";
  }

  function activeMemberOptions(selected = "") {
    return activeMembers.map(m =>
      `<option value="${m.member_id}" ${m.member_id === selected ? "selected" : ""}>${escapeHtml(m.member_name)}</option>`
    ).join("");
  }

  function allMemberOptions(selected = "") {
    return allMembers.map(m =>
      `<option value="${m.member_id}" ${m.member_id === selected ? "selected" : ""}>${escapeHtml(m.member_name)}${m.is_active ? "" : " (비활성)"}</option>`
    ).join("");
  }

  function memberName(id) {
    return allMembers.find(m => m.member_id === id)?.member_name || "-";
  }

  function defaultAssigneeId() {
    if (
      selectedMemberId !== "ALL" &&
      activeMembers.some(m => m.member_id === selectedMemberId)
    ) {
      return selectedMemberId;
    }

    const currentValue = $("taskAssignee")?.value || "";
    if (activeMembers.some(m => m.member_id === currentValue)) {
      return currentValue;
    }

    return activeMembers[0]?.member_id || "";
  }

  function renderMemberControls() {
    const assignee = $("taskAssignee");

    if (!activeMembers.length) {
      assignee.innerHTML = '<option value="">팀원 없음</option>';
    } else {
      const preferred = defaultAssigneeId();
      assignee.innerHTML = activeMemberOptions(preferred);

      if (preferred) {
        assignee.value = preferred;
      }
    }

    const tabs = [
      `<button type="button" class="member-tab ${selectedMemberId === "ALL" ? "active" : ""}" data-member="ALL">전체</button>`,
      ...activeMembers.map(m =>
        `<button type="button" class="member-tab ${selectedMemberId === m.member_id ? "active" : ""}" data-member="${m.member_id}">${escapeHtml(m.member_name)}</button>`
      )
    ];

    $("memberTabs").innerHTML = tabs.join("");

    $$(".member-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        selectedMemberId = btn.dataset.member;

        // 사람 선택이 가장 중요한 1차 분류.
        // 특정 사람 탭에서는 신규 업무의 담당자도 그 사람으로 자동 지정한다.
        if (
          selectedMemberId !== "ALL" &&
          activeMembers.some(m => m.member_id === selectedMemberId)
        ) {
          $("taskAssignee").value = selectedMemberId;
        }

        renderMemberControls();
        renderBoard();
      });
    });
  }

  function actorMemberId(task = null) {
    if (task?.assigned_to && allMembers.some(m => m.member_id === task.assigned_to)) {
      return task.assigned_to;
    }

    if (
      selectedMemberId !== "ALL" &&
      allMembers.some(m => m.member_id === selectedMemberId)
    ) {
      return selectedMemberId;
    }

    const selectedAssignee = $("taskAssignee")?.value || "";
    if (selectedAssignee && allMembers.some(m => m.member_id === selectedAssignee)) {
      return selectedAssignee;
    }

    return activeMembers[0]?.member_id || "";
  }

  function statusLabel(status) {
    return status === "IN_PROGRESS" ? "진행중"
      : status === "DONE" ? "완료"
      : "요청";
  }

  function statusRank(status) {
    return status === "REQUESTED" ? 0 : status === "IN_PROGRESS" ? 1 : 2;
  }

  function formatDateTime(value) {
    if (!value) return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";

    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(d);
  }

  function uniqueCategories() {
    return [...new Set(
      tasks.map(t => String(t.category || "기타").trim() || "기타")
    )].sort((a, b) => a.localeCompare(b, "ko"));
  }

  function renderCategoryFilter() {
    const categories = uniqueCategories();
    const selected = categories.includes(filterState.category)
      ? filterState.category
      : "ALL";

    filterState.category = selected;
    $("taskCategoryFilter").innerHTML = [
      '<option value="ALL">전체</option>',
      ...categories.map(c =>
        `<option value="${escapeHtml(c)}" ${c === selected ? "selected" : ""}>${escapeHtml(c)}</option>`
      )
    ].join("");

    // Existing user-created categories also become input suggestions.
    const defaults = [
      "3D 프린트", "제작", "구매", "정리", "박물관",
      "예약", "강사", "우지", "유워시", "기타"
    ];
    const all = [...new Set([...defaults, ...categories])];

    $("taskCategoryList").innerHTML = all
      .map(c => `<option value="${escapeHtml(c)}"></option>`)
      .join("");
  }

  function saveFilterState() {
    localStorage.setItem(FILTER_KEY, JSON.stringify({
      ...filterState,
      selectedMemberId
    }));
  }

  function restoreFilterState() {
    try {
      const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || "{}");

      if (typeof saved.search === "string") filterState.search = saved.search;
      if (["ALL", "REQUESTED", "IN_PROGRESS", "DONE"].includes(saved.status)) {
        filterState.status = saved.status;
      }
      if (typeof saved.category === "string") filterState.category = saved.category;
      if (["STATUS", "ASSIGNEE", "CATEGORY", "LIST"].includes(saved.group)) {
        filterState.group = saved.group;
      }
      if (["NEWEST", "OLDEST", "STATUS", "ASSIGNEE", "CATEGORY", "QTY_DESC"].includes(saved.sort)) {
        filterState.sort = saved.sort;
      }
      if (typeof saved.selectedMemberId === "string") {
        selectedMemberId = saved.selectedMemberId;
      }
    } catch (_) {}
  }

  function syncFilterControls() {
    $("taskSearch").value = filterState.search;
    $("taskStatusFilter").value = filterState.status;
    $("taskGroupMode").value = filterState.group;
    $("taskSortMode").value = filterState.sort;
    renderCategoryFilter();
  }

  function filteredTasks() {
    const q = filterState.search.trim().toLocaleLowerCase("ko");

    let rows = tasks.filter(task => {
      if (selectedMemberId !== "ALL" && task.assigned_to !== selectedMemberId) {
        return false;
      }

      if (filterState.status !== "ALL" && task.status !== filterState.status) {
        return false;
      }

      const category = String(task.category || "기타").trim() || "기타";
      if (filterState.category !== "ALL" && category !== filterState.category) {
        return false;
      }

      if (q) {
        const haystack = [
          task.title,
          task.description,
          task.category,
          task.requested_name,
          task.assigned_name,
          statusLabel(task.status)
        ].filter(Boolean).join(" ").toLocaleLowerCase("ko");

        if (!haystack.includes(q)) return false;
      }

      return true;
    });

    const collator = new Intl.Collator("ko");

    rows.sort((a, b) => {
      switch (filterState.sort) {
        case "OLDEST":
          return String(a.created_at).localeCompare(String(b.created_at));

        case "STATUS":
          return statusRank(a.status) - statusRank(b.status)
            || String(b.created_at).localeCompare(String(a.created_at));

        case "ASSIGNEE":
          return collator.compare(a.assigned_name || "", b.assigned_name || "")
            || String(b.created_at).localeCompare(String(a.created_at));

        case "CATEGORY":
          return collator.compare(a.category || "", b.category || "")
            || String(b.created_at).localeCompare(String(a.created_at));

        case "QTY_DESC":
          return Number(b.quantity || 0) - Number(a.quantity || 0)
            || String(b.created_at).localeCompare(String(a.created_at));

        case "NEWEST":
        default:
          return String(b.created_at).localeCompare(String(a.created_at));
      }
    });

    return rows;
  }

  function taskCard(task) {
    const qty = task.quantity
      ? `<span class="task-qty">수량 ${Number(task.quantity).toLocaleString("ko-KR")}</span>`
      : "";

    let actions = "";

    if (task.status === "REQUESTED") {
      actions = `<button data-status="IN_PROGRESS" data-id="${task.task_id}" class="task-action primary-small">진행 시작</button>`;
    } else if (task.status === "IN_PROGRESS") {
      actions = `
        <button data-status="DONE" data-id="${task.task_id}" class="task-action primary-small">완료</button>
        <button data-status="REQUESTED" data-id="${task.task_id}" class="task-action">요청으로</button>
      `;
    } else {
      actions = `<button data-status="REQUESTED" data-id="${task.task_id}" class="task-action">다시 열기</button>`;
    }

    return `
      <article class="task-card ${task.status === "DONE" ? "completed" : ""}" data-task-id="${task.task_id}">
        <div class="task-card-top">
          <div class="task-card-tags">
            <span class="task-category">${escapeHtml(task.category || "기타")}</span>
            <span class="task-status-chip status-${String(task.status).toLowerCase()}">${statusLabel(task.status)}</span>
          </div>
          ${qty}
        </div>

        <h3>${escapeHtml(task.title)}</h3>

        ${task.description
          ? `<p class="task-desc">${escapeHtml(task.description)}</p>`
          : ""}

        <div class="task-people task-assignee-only">
          <span><em>담당</em><strong>${escapeHtml(task.assigned_name || "-")}</strong></span>
        </div>

        <div class="task-card-foot">
          <span>${formatDateTime(task.created_at)}</span>
          <div class="task-card-actions">
            ${actions}
            <button data-edit="${task.task_id}" class="task-action edit">수정</button>
          </div>
        </div>
      </article>
    `;
  }

  function groupRows(rows) {
    if (filterState.group === "LIST") {
      return [{ key: "ALL", label: "전체 업무", rows }];
    }

    if (filterState.group === "STATUS") {
      const groups = [
        ["REQUESTED", "요청"],
        ["IN_PROGRESS", "진행중"],
        ["DONE", "완료"]
      ];

      return groups
        .map(([key, label]) => ({
          key,
          label,
          rows: rows.filter(t => t.status === key)
        }))
        .filter(group => filterState.status === "ALL" || group.key === filterState.status);
    }

    const keyFn = filterState.group === "ASSIGNEE"
      ? task => task.assigned_to || "UNASSIGNED"
      : task => String(task.category || "기타").trim() || "기타";

    const labelFn = filterState.group === "ASSIGNEE"
      ? (key, sample) => sample?.assigned_name || memberName(key) || "담당 없음"
      : key => key;

    const map = new Map();

    for (const task of rows) {
      const key = keyFn(task);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(task);
    }

    return [...map.entries()]
      .map(([key, groupedRows]) => ({
        key,
        label: labelFn(key, groupedRows[0]),
        rows: groupedRows
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "ko"));
  }

  function bindTaskCardActions() {
    $$(".task-action[data-status]").forEach(btn =>
      btn.addEventListener("click", () =>
        changeStatus(btn.dataset.id, btn.dataset.status)
      )
    );

    $$(".task-action[data-edit]").forEach(btn =>
      btn.addEventListener("click", () =>
        openEdit(btn.dataset.edit)
      )
    );
  }

  function renderBoard() {
    const rows = filteredTasks();
    const groups = groupRows(rows);

    const modeClass = filterState.group === "STATUS"
      ? "board-status"
      : filterState.group === "LIST"
        ? "board-list"
        : "board-flex";

    $("taskBoard").className = `task-board dynamic-task-board ${modeClass}`;

    if (!rows.length) {
      $("taskBoard").innerHTML =
        '<div class="task-board-empty">조건에 맞는 업무가 없습니다.</div>';
    } else {
      $("taskBoard").innerHTML = groups.map(group => `
        <section class="task-group" data-group="${escapeHtml(group.key)}">
          <div class="task-column-head">
            <div>
              <span class="task-status-dot ${filterState.group === "STATUS" ? `dot-${group.key.toLowerCase()}` : ""}"></span>
              <strong>${escapeHtml(group.label)}</strong>
            </div>
            <span class="task-count">${group.rows.length}</span>
          </div>
          <div class="task-card-list">
            ${group.rows.length
              ? group.rows.map(taskCard).join("")
              : '<div class="task-empty">업무가 없습니다.</div>'}
          </div>
        </section>
      `).join("");
    }

    const total = tasks.length;
    $("taskVisibleSummary").textContent =
      `표시 ${rows.length}건 / 전체 ${total}건`;

    saveFilterState();
    bindTaskCardActions();
  }

  function renderMemberManage() {
    $("memberManageList").innerHTML = allMembers.map(m => `
      <div class="member-manage-row ${m.is_active ? "" : "inactive"}">
        <div>
          <strong>${escapeHtml(m.member_name)}</strong>
          <span>${m.is_active ? "사용중" : "비활성"}</span>
        </div>
        <div class="member-manage-actions">
          <button type="button" class="task-mini-btn" data-rename="${m.member_id}">이름수정</button>
          <button type="button"
                  class="task-mini-btn ${m.is_active ? "danger-lite" : ""}"
                  data-active="${m.member_id}"
                  data-value="${m.is_active ? "false" : "true"}">
            ${m.is_active ? "삭제" : "복원"}
          </button>
        </div>
      </div>
    `).join("");

    $$("[data-rename]").forEach(btn =>
      btn.addEventListener("click", () =>
        renameMember(btn.dataset.rename)
      )
    );

    $$("[data-active]").forEach(btn =>
      btn.addEventListener("click", () =>
        setMemberActive(btn.dataset.active, btn.dataset.value === "true")
      )
    );
  }

  async function loadMembers() {
    if (!token()) return;

    const { data, error } = await client.rpc("kcem_tasks_members", {
      p_token: token(),
      p_include_inactive: true
    });

    if (error) throw error;

    allMembers = Array.isArray(data) ? data : [];
    activeMembers = allMembers.filter(m => m.is_active);

    if (
      selectedMemberId !== "ALL" &&
      !allMembers.some(m => m.member_id === selectedMemberId)
    ) {
      selectedMemberId = "ALL";
    }

    renderMemberControls();
    renderMemberManage();
  }

  async function loadTasks() {
    if (!token()) return;

    const { data, error } = await client.rpc("kcem_tasks_list", {
      p_token: token()
    });

    if (error) throw error;

    tasks = Array.isArray(data) ? data : [];
    renderCategoryFilter();
    renderBoard();

    $("taskLastUpdated").textContent =
      `마지막 갱신: ${new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }).format(new Date())}`;
  }

  async function loadAll() {
    if (!token() || !client) return;

    try {
      taskApiReady = true;
      $("taskSetupNotice").classList.add("hidden");

      await loadMembers();
      await loadTasks();

      if (!activeMembers.length) {
        $("taskEntryMessage").textContent =
          "팀원관리에서 팀원을 먼저 추가하세요.";
      } else {
        $("taskEntryMessage").textContent = "";
      }
    } catch (error) {
      $("taskEntryMessage").textContent = rpcErrorText(error);
      console.error("KCEM tasks load error", error);
    }
  }

  // ------------------------------------------------------------------
  // Natural language assistant (browser-side, no external API key)
  // ------------------------------------------------------------------
  function detectCategory(text) {
    const lower = text.toLocaleLowerCase("ko");

    // User-created/existing categories have priority.
    const existing = uniqueCategories()
      .filter(c => c && c !== "기타")
      .sort((a, b) => b.length - a.length);

    for (const category of existing) {
      if (lower.includes(category.toLocaleLowerCase("ko"))) {
        return category;
      }
    }

    const rules = [
      ["3D 프린트", ["3d", "3d프린트", "3d 프린트", "프린트", "프린팅", "출력", "필라멘트", "모델링"]],
      ["구매", ["구매", "구입", "주문", "발주", "사야", "사주세요", "재료 필요"]],
      ["제작", ["제작", "만들", "가공", "조립", "제작해", "만들어"]],
      ["정리", ["정리", "청소", "치우", "정돈", "정리해"]],
      ["예약", ["예약", "예약자", "단체예약", "예약 확인"]],
      ["강사", ["강사", "수업", "교육", "출강", "강의"]],
      ["우지", ["우지", "oozy", "커피"]],
      ["유워시", ["유워시", "uwash", "세차"]],
      ["박물관", ["박물관", "전시", "체험", "수장고", "포토존", "전시실"]]
    ];

    for (const [category, keywords] of rules) {
      if (keywords.some(keyword => lower.includes(keyword))) {
        return category;
      }
    }

    return $("taskCategory").value.trim() || "기타";
  }

  function detectAssignee(text) {
    const compact = text.replace(/\s+/g, "").toLocaleLowerCase("ko");

    // Explicit member name in the sentence wins.
    for (const member of activeMembers) {
      const name = String(member.member_name || "");
      const compactName = name.replace(/\s+/g, "").toLocaleLowerCase("ko");
      if (compactName && compact.includes(compactName)) {
        return member.member_id;
      }
    }

    // 특정 사람 탭을 보고 있다면 그 사람이 가장 강한 기본 담당자다.
    if (
      selectedMemberId !== "ALL" &&
      activeMembers.some(m => m.member_id === selectedMemberId)
    ) {
      return selectedMemberId;
    }

    // 문장에 담당자 단서가 없으면 현재 등록폼 담당자를 유지한다.
    return $("taskAssignee").value || activeMembers[0]?.member_id || "";
  }

  function detectQuantity(text) {
    const cleaned = text.replace(/,/g, "");

    const totalMatch = cleaned.match(/총\s*(\d+)\s*(?:개|세트|장|명|건|롤|통|개입)?/i);
    if (totalMatch) return Number(totalMatch[1]);

    const mul1 = cleaned.match(/(\d+)\s*종\s*(?:x|×|\*)?\s*(\d+)\s*개씩/i);
    if (mul1) return Number(mul1[1]) * Number(mul1[2]);

    const mul2 = cleaned.match(/(\d+)\s*개씩\s*(\d+)\s*종/i);
    if (mul2) return Number(mul2[1]) * Number(mul2[2]);

    const qtyMatches = [...cleaned.matchAll(/(\d+)\s*(개|세트|장|명|건|롤|통)\b/g)];
    if (qtyMatches.length) {
      return Number(qtyMatches[qtyMatches.length - 1][1]);
    }

    return null;
  }

  function analyzeNaturalTask(showMessage = true) {
    const text = $("taskTitle").value.trim();

    if (!text) {
      if (showMessage) {
        $("taskEntryMessage").textContent = "업무 내용을 먼저 입력하세요.";
      }
      return null;
    }

    const category = detectCategory(text);
    const assignedTo = detectAssignee(text);
    const quantity = detectQuantity(text);

    $("taskCategory").value = category;

    if (
      assignedTo &&
      activeMembers.some(m => m.member_id === assignedTo)
    ) {
      $("taskAssignee").value = assignedTo;
    }

    if (quantity && Number.isInteger(quantity) && quantity > 0) {
      $("taskQuantity").value = quantity;
    }

    const chips = [
      `<span><em>분류</em>${escapeHtml(category)}</span>`,
      `<span><em>담당</em>${escapeHtml(memberName(assignedTo))}</span>`
    ];

    if (quantity) {
      chips.push(`<span><em>수량</em>${Number(quantity).toLocaleString("ko-KR")}</span>`);
    }

    $("taskAnalyzePreview").innerHTML =
      `<strong>자동분류</strong>${chips.join("")}`;
    $("taskAnalyzePreview").classList.remove("hidden");

    if (showMessage) {
      $("taskEntryMessage").textContent =
        "자동분류했습니다. 필요한 항목만 확인한 뒤 등록하세요.";
    }

    return { category, assignedTo, quantity };
  }

  async function addTask() {
    if (!taskApiReady) return;

    const title = $("taskTitle").value.trim();

    if (!title) {
      $("taskEntryMessage").textContent = "업무 내용을 입력하세요.";
      return;
    }

    // If the user typed a sentence and didn't press auto-classify,
    // analyze once automatically before saving.
    analyzeNaturalTask(false);

    const category = $("taskCategory").value.trim() || "기타";
    const description = $("taskDescription").value.trim();
    const quantityText = $("taskQuantity").value.trim();
    const quantity = quantityText ? Number(quantityText) : null;
    const assigned = $("taskAssignee").value;

    if (!assigned) {
      $("taskEntryMessage").textContent = "담당자를 선택하세요.";
      return;
    }

    if (quantity !== null && (!Number.isInteger(quantity) || quantity < 1)) {
      $("taskEntryMessage").textContent =
        "수량은 1 이상의 정수로 입력하세요.";
      return;
    }

    $("taskAddBtn").disabled = true;
    $("taskAddBtn").textContent = "등록 중…";

    try {
      const { error } = await client.rpc("kcem_tasks_create", {
        p_token: token(),
        p_category: category,
        p_title: title,
        p_description: description || null,
        p_quantity: quantity,
        // 작성자 개념은 UI에서 사용하지 않는다.
        // 기존 DB/RPC 호환을 위해 requested_by에는 담당자를 기록한다.
        p_requested_by: assigned,
        p_assigned_to: assigned
      });

      if (error) throw error;

      $("taskTitle").value = "";
      $("taskDescription").value = "";
      $("taskQuantity").value = "";
      $("taskCategory").value = "";
      $("taskAnalyzePreview").classList.add("hidden");
      $("taskAnalyzePreview").innerHTML = "";
      $("taskEntryMessage").textContent = "";
      $("taskTitle").focus();

      await loadTasks();
    } catch (error) {
      $("taskEntryMessage").textContent = rpcErrorText(error);
    } finally {
      $("taskAddBtn").disabled = false;
      $("taskAddBtn").textContent = "업무 등록";
    }
  }

  async function changeStatus(taskId, status) {
    const task = tasks.find(t => t.task_id === taskId);
    const actor = actorMemberId(task);
    if (!actor) return;

    try {
      const { error } = await client.rpc("kcem_tasks_set_status", {
        p_token: token(),
        p_task_id: taskId,
        p_status: status,
        p_actor_member_id: actor
      });

      if (error) throw error;
      await loadTasks();
    } catch (error) {
      alert(rpcErrorText(error));
    }
  }

  function openEdit(taskId) {
    const task = tasks.find(t => t.task_id === taskId);
    if (!task) return;

    $("taskEditId").value = task.task_id;
    $("taskEditCategory").value = task.category || "";
    $("taskEditTitle").value = task.title || "";
    $("taskEditDescription").value = task.description || "";
    $("taskEditQuantity").value = task.quantity || "";
    $("taskEditAssignee").innerHTML = allMemberOptions(task.assigned_to);
    $("taskEditStatus").value = task.status;
    $("taskEditMessage").textContent = "";
    $("taskEditOverlay").classList.remove("hidden");
  }

  function closeEdit() {
    $("taskEditOverlay").classList.add("hidden");
  }

  async function saveEdit() {
    const id = $("taskEditId").value;
    const qtyText = $("taskEditQuantity").value.trim();
    const qty = qtyText ? Number(qtyText) : null;
    const title = $("taskEditTitle").value.trim();

    if (!title) {
      $("taskEditMessage").textContent = "업무 내용을 입력하세요.";
      return;
    }

    if (qty !== null && (!Number.isInteger(qty) || qty < 1)) {
      $("taskEditMessage").textContent = "수량을 확인하세요.";
      return;
    }

    try {
      $("taskEditSaveBtn").disabled = true;

      const originalTask = tasks.find(t => t.task_id === id);
      const assignedTo = $("taskEditAssignee").value;
      const actor = assignedTo || actorMemberId(originalTask);

      const { error } = await client.rpc("kcem_tasks_update", {
        p_token: token(),
        p_task_id: id,
        p_category: $("taskEditCategory").value.trim() || "기타",
        p_title: title,
        p_description: $("taskEditDescription").value.trim() || null,
        p_quantity: qty,
        // 작성자는 화면에 노출하지 않는다. 기존 값이 있으면 보존한다.
        p_requested_by: originalTask?.requested_by || assignedTo,
        p_assigned_to: assignedTo,
        p_status: $("taskEditStatus").value,
        p_actor_member_id: actor
      });

      if (error) throw error;

      closeEdit();
      await loadTasks();
    } catch (error) {
      $("taskEditMessage").textContent = rpcErrorText(error);
    } finally {
      $("taskEditSaveBtn").disabled = false;
    }
  }

  async function deleteTask() {
    const id = $("taskEditId").value;
    const task = tasks.find(t => t.task_id === id);

    if (!task || !confirm(`'${task.title}' 업무를 삭제할까요?`)) return;

    try {
      const { error } = await client.rpc("kcem_tasks_delete", {
        p_token: token(),
        p_task_id: id,
        p_actor_member_id: actorMemberId(task)
      });

      if (error) throw error;

      closeEdit();
      await loadTasks();
    } catch (error) {
      $("taskEditMessage").textContent = rpcErrorText(error);
    }
  }

  async function addMember() {
    const name = $("newMemberName").value.trim();
    if (!name) return;

    try {
      const { error } = await client.rpc("kcem_tasks_member_create", {
        p_token: token(),
        p_name: name
      });

      if (error) throw error;

      $("newMemberName").value = "";
      await loadMembers();
    } catch (error) {
      $("memberMessage").textContent = rpcErrorText(error);
    }
  }

  async function renameMember(id) {
    const member = allMembers.find(m => m.member_id === id);
    if (!member) return;

    const name = prompt("새 팀원 이름", member.member_name);
    if (name === null || !name.trim()) return;

    try {
      const { error } = await client.rpc("kcem_tasks_member_rename", {
        p_token: token(),
        p_member_id: id,
        p_name: name.trim()
      });

      if (error) throw error;

      await loadMembers();
      await loadTasks();
    } catch (error) {
      $("memberMessage").textContent = rpcErrorText(error);
    }
  }

  async function setMemberActive(id, active) {
    const member = allMembers.find(m => m.member_id === id);
    if (!member) return;

    if (
      !active &&
      !confirm(`${member.member_name} 팀원을 삭제(비활성)할까요?\n과거 업무 기록의 이름은 유지됩니다.`)
    ) {
      return;
    }

    try {
      const { error } = await client.rpc("kcem_tasks_member_set_active", {
        p_token: token(),
        p_member_id: id,
        p_is_active: active
      });

      if (error) throw error;

      await loadMembers();
      await loadTasks();
    } catch (error) {
      $("memberMessage").textContent = rpcErrorText(error);
    }
  }

  function resetFilters() {
    selectedMemberId = "ALL";
    filterState.search = "";
    filterState.status = "ALL";
    filterState.category = "ALL";
    filterState.group = "STATUS";
    filterState.sort = "NEWEST";

    syncFilterControls();
    renderMemberControls();
    renderBoard();
  }

  function bindFilters() {
    $("taskSearch").addEventListener("input", e => {
      filterState.search = e.target.value;
      renderBoard();
    });

    $("taskStatusFilter").addEventListener("change", e => {
      filterState.status = e.target.value;
      renderBoard();
    });

    $("taskCategoryFilter").addEventListener("change", e => {
      filterState.category = e.target.value;
      renderBoard();
    });

    $("taskGroupMode").addEventListener("change", e => {
      filterState.group = e.target.value;
      renderBoard();
    });

    $("taskSortMode").addEventListener("change", e => {
      filterState.sort = e.target.value;
      renderBoard();
    });

    $("taskFilterResetBtn").addEventListener("click", resetFilters);
  }

  function startPolling() {
    stopPolling();

    pollTimer = setInterval(() => {
      if (
        !document.hidden &&
        !$("taskApp").classList.contains("hidden")
      ) {
        loadAll();
      }
    }, Math.max(5000, Number(cfg.POLL_INTERVAL_MS || 5000)));
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function bind() {
    $$(".module-tab").forEach(btn =>
      btn.addEventListener("click", () =>
        setModule(btn.dataset.module)
      )
    );

    $("taskAnalyzeBtn").addEventListener("click", () =>
      analyzeNaturalTask(true)
    );

    $("taskAddBtn").addEventListener("click", addTask);

    $("taskTitle").addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        analyzeNaturalTask(true);
      }
    });

    $("taskRefreshBtn").addEventListener("click", loadAll);

    $("memberManageBtn").addEventListener("click", () => {
      renderMemberManage();
      $("memberOverlay").classList.remove("hidden");
    });

    $("memberCloseBtn").addEventListener("click", () =>
      $("memberOverlay").classList.add("hidden")
    );

    $("memberAddBtn").addEventListener("click", addMember);

    $("newMemberName").addEventListener("keydown", e => {
      if (e.key === "Enter") addMember();
    });

    $("taskEditCloseBtn").addEventListener("click", closeEdit);
    $("taskEditCancelBtn").addEventListener("click", closeEdit);

    $("taskEditForm").addEventListener("submit", e => {
      e.preventDefault();
      saveEdit();
    });

    $("taskDeleteBtn").addEventListener("click", deleteTask);

    bindFilters();
  }

  function start() {
    if (
      !cfg.SUPABASE_URL ||
      !cfg.SUPABASE_PUBLISHABLE_KEY ||
      !window.supabase
    ) {
      return;
    }

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

    restoreFilterState();
    bind();
    syncFilterControls();

    // Keep the sales page as the default first screen.
    setModule("sales");
  }

  start();
})();
