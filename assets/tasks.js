(() => {
  const cfg = window.KCEM_CONFIG || {};
  const $ = id => document.getElementById(id);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const TOKEN_KEY = "kcem_public_access_token";
  const CURRENT_MEMBER_KEY = "kcem_current_team_member";
  const MODULE_KEY = "kcem_current_module";

  let client = null;
  let allMembers = [];
  let activeMembers = [];
  let tasks = [];
  let currentMemberId = localStorage.getItem(CURRENT_MEMBER_KEY) || "";
  let selectedMemberId = "ALL";
  let pollTimer = null;
  let taskApiReady = true;

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
    $$(".module-tab").forEach(btn => btn.classList.toggle("active", btn.dataset.module === module));
    localStorage.setItem(MODULE_KEY, module);
    if (isTasks) {
      loadAll();
      startPolling();
    } else {
      stopPolling();
    }
  }

  function rpcErrorText(error) {
    const text = [error?.message, error?.details, error?.hint, error?.code].filter(Boolean).join(" / ");
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
    return activeMembers.map(m => `<option value="${m.member_id}" ${m.member_id===selected?'selected':''}>${escapeHtml(m.member_name)}</option>`).join("");
  }

  function allMemberOptions(selected = "") {
    return allMembers.map(m => `<option value="${m.member_id}" ${m.member_id===selected?'selected':''}>${escapeHtml(m.member_name)}${m.is_active?'':' (비활성)'}</option>`).join("");
  }

  function ensureCurrentMember() {
    if (currentMemberId && activeMembers.some(m => m.member_id === currentMemberId)) return;
    currentMemberId = activeMembers[0]?.member_id || "";
    if (currentMemberId) localStorage.setItem(CURRENT_MEMBER_KEY, currentMemberId);
    else localStorage.removeItem(CURRENT_MEMBER_KEY);
  }

  function renderMemberControls() {
    ensureCurrentMember();
    const select = $("currentMemberSelect");
    const assignee = $("taskAssignee");

    if (!activeMembers.length) {
      select.innerHTML = '<option value="">팀원 없음</option>';
      assignee.innerHTML = '<option value="">팀원 없음</option>';
      $("taskAddBtn").disabled = true;
    } else {
      select.innerHTML = activeMemberOptions(currentMemberId);
      assignee.innerHTML = activeMemberOptions(currentMemberId);
      $("taskAddBtn").disabled = false;
    }

    const tabs = [
      `<button class="member-tab ${selectedMemberId==='ALL'?'active':''}" data-member="ALL">전체</button>`,
      ...activeMembers.map(m => `<button class="member-tab ${selectedMemberId===m.member_id?'active':''}" data-member="${m.member_id}">${escapeHtml(m.member_name)}</button>`)
    ];
    $("memberTabs").innerHTML = tabs.join("");
    $$(".member-tab").forEach(btn => btn.addEventListener("click", () => {
      selectedMemberId = btn.dataset.member;
      renderMemberControls();
      renderBoard();
    }));
  }

  function filteredTasks() {
    if (selectedMemberId === "ALL") return tasks;
    return tasks.filter(t => t.assigned_to === selectedMemberId);
  }

  function statusLabel(status) {
    return status === "IN_PROGRESS" ? "진행중" : status === "DONE" ? "완료" : "요청";
  }

  function formatDateTime(value) {
    if (!value) return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"
    }).format(d);
  }

  function taskCard(task) {
    const qty = task.quantity ? `<span class="task-qty">수량 ${Number(task.quantity).toLocaleString('ko-KR')}</span>` : "";
    let actions = "";
    if (task.status === "REQUESTED") {
      actions = `<button data-status="IN_PROGRESS" data-id="${task.task_id}" class="task-action primary-small">진행 시작</button>`;
    } else if (task.status === "IN_PROGRESS") {
      actions = `<button data-status="DONE" data-id="${task.task_id}" class="task-action primary-small">완료</button><button data-status="REQUESTED" data-id="${task.task_id}" class="task-action">요청으로</button>`;
    } else {
      actions = `<button data-status="REQUESTED" data-id="${task.task_id}" class="task-action">다시 열기</button>`;
    }

    return `<article class="task-card ${task.status==='DONE'?'completed':''}" data-task-id="${task.task_id}">
      <div class="task-card-top">
        <span class="task-category">${escapeHtml(task.category || '기타')}</span>
        ${qty}
      </div>
      <h3>${escapeHtml(task.title)}</h3>
      ${task.description ? `<p class="task-desc">${escapeHtml(task.description)}</p>` : ''}
      <div class="task-people">
        <span><em>요청</em>${escapeHtml(task.requested_name || '-')}</span>
        <span class="task-arrow">→</span>
        <span><em>담당</em><strong>${escapeHtml(task.assigned_name || '-')}</strong></span>
      </div>
      <div class="task-card-foot">
        <span>${formatDateTime(task.created_at)}</span>
        <div class="task-card-actions">${actions}<button data-edit="${task.task_id}" class="task-action edit">수정</button></div>
      </div>
    </article>`;
  }

  function renderBoard() {
    const rows = filteredTasks();
    const requested = rows.filter(t => t.status === "REQUESTED");
    const progress = rows.filter(t => t.status === "IN_PROGRESS");
    const done = rows.filter(t => t.status === "DONE");

    $("requestedCount").textContent = requested.length;
    $("progressCount").textContent = progress.length;
    $("doneCount").textContent = done.length;
    $("requestedTasks").innerHTML = requested.length ? requested.map(taskCard).join("") : '<div class="task-empty">요청된 업무가 없습니다.</div>';
    $("progressTasks").innerHTML = progress.length ? progress.map(taskCard).join("") : '<div class="task-empty">진행중인 업무가 없습니다.</div>';
    $("doneTasks").innerHTML = done.length ? done.map(taskCard).join("") : '<div class="task-empty">완료된 업무가 없습니다.</div>';

    $$(".task-action[data-status]").forEach(btn => btn.addEventListener("click", () => changeStatus(btn.dataset.id, btn.dataset.status)));
    $$(".task-action[data-edit]").forEach(btn => btn.addEventListener("click", () => openEdit(btn.dataset.edit)));
  }

  function renderMemberManage() {
    $("memberManageList").innerHTML = allMembers.map(m => `<div class="member-manage-row ${m.is_active?'':'inactive'}">
      <div><strong>${escapeHtml(m.member_name)}</strong><span>${m.is_active?'사용중':'비활성'}</span></div>
      <div class="member-manage-actions">
        <button type="button" class="task-mini-btn" data-rename="${m.member_id}">이름수정</button>
        <button type="button" class="task-mini-btn ${m.is_active?'danger-lite':''}" data-active="${m.member_id}" data-value="${m.is_active?'false':'true'}">${m.is_active?'삭제':'복원'}</button>
      </div>
    </div>`).join("");

    $$("[data-rename]").forEach(btn => btn.addEventListener("click", () => renameMember(btn.dataset.rename)));
    $$("[data-active]").forEach(btn => btn.addEventListener("click", () => setMemberActive(btn.dataset.active, btn.dataset.value === 'true')));
  }

  async function loadMembers() {
    if (!token()) return;
    const { data, error } = await client.rpc("kcem_tasks_members", { p_token: token(), p_include_inactive: true });
    if (error) throw error;
    allMembers = Array.isArray(data) ? data : [];
    activeMembers = allMembers.filter(m => m.is_active);
    renderMemberControls();
    renderMemberManage();
  }

  async function loadTasks() {
    if (!token()) return;
    const { data, error } = await client.rpc("kcem_tasks_list", { p_token: token() });
    if (error) throw error;
    tasks = Array.isArray(data) ? data : [];
    renderBoard();
    $("taskLastUpdated").textContent = `마지막 갱신: ${new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date())}`;
  }

  async function loadAll() {
    if (!token() || !client) return;
    try {
      taskApiReady = true;
      $("taskSetupNotice").classList.add("hidden");
      await loadMembers();
      await loadTasks();
      if (!activeMembers.length) {
        $("taskEntryMessage").textContent = "팀원관리에서 팀원을 먼저 추가하세요.";
      } else {
        $("taskEntryMessage").textContent = "";
      }
    } catch (error) {
      $("taskEntryMessage").textContent = rpcErrorText(error);
      console.error("KCEM tasks load error", error);
    }
  }

  async function addTask() {
    if (!taskApiReady) return;
    const title = $("taskTitle").value.trim();
    const category = $("taskCategory").value.trim() || "기타";
    const description = $("taskDescription").value.trim();
    const quantityText = $("taskQuantity").value.trim();
    const quantity = quantityText ? Number(quantityText) : null;
    const assigned = $("taskAssignee").value;

    if (!currentMemberId) return $("taskEntryMessage").textContent = "현재 작성자를 선택하세요.";
    if (!assigned) return $("taskEntryMessage").textContent = "담당자를 선택하세요.";
    if (!title) return $("taskEntryMessage").textContent = "업무 내용을 입력하세요.";
    if (quantity !== null && (!Number.isInteger(quantity) || quantity < 1)) return $("taskEntryMessage").textContent = "수량은 1 이상의 정수로 입력하세요.";

    $("taskAddBtn").disabled = true;
    $("taskAddBtn").textContent = "등록 중…";
    try {
      const { error } = await client.rpc("kcem_tasks_create", {
        p_token: token(), p_category: category, p_title: title,
        p_description: description || null, p_quantity: quantity,
        p_requested_by: currentMemberId, p_assigned_to: assigned
      });
      if (error) throw error;
      $("taskTitle").value = "";
      $("taskDescription").value = "";
      $("taskQuantity").value = "";
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
    if (!currentMemberId) return;
    try {
      const { error } = await client.rpc("kcem_tasks_set_status", {
        p_token: token(), p_task_id: taskId, p_status: status, p_actor_member_id: currentMemberId
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
    $("taskEditRequester").innerHTML = allMemberOptions(task.requested_by);
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
    if (!title) return $("taskEditMessage").textContent = "업무 내용을 입력하세요.";
    if (qty !== null && (!Number.isInteger(qty) || qty < 1)) return $("taskEditMessage").textContent = "수량을 확인하세요.";
    try {
      $("taskEditSaveBtn").disabled = true;
      const { error } = await client.rpc("kcem_tasks_update", {
        p_token: token(), p_task_id: id,
        p_category: $("taskEditCategory").value.trim() || "기타",
        p_title: title, p_description: $("taskEditDescription").value.trim() || null,
        p_quantity: qty, p_requested_by: $("taskEditRequester").value,
        p_assigned_to: $("taskEditAssignee").value, p_status: $("taskEditStatus").value,
        p_actor_member_id: currentMemberId
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
      const { error } = await client.rpc("kcem_tasks_delete", { p_token: token(), p_task_id: id, p_actor_member_id: currentMemberId });
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
      const { error } = await client.rpc("kcem_tasks_member_create", { p_token: token(), p_name: name });
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
      const { error } = await client.rpc("kcem_tasks_member_rename", { p_token: token(), p_member_id: id, p_name: name.trim() });
      if (error) throw error;
      await loadMembers();
      await loadTasks();
    } catch (error) { $("memberMessage").textContent = rpcErrorText(error); }
  }

  async function setMemberActive(id, active) {
    const member = allMembers.find(m => m.member_id === id);
    if (!member) return;
    if (!active && !confirm(`${member.member_name} 팀원을 삭제(비활성)할까요?\n과거 업무 기록의 이름은 유지됩니다.`)) return;
    try {
      const { error } = await client.rpc("kcem_tasks_member_set_active", { p_token: token(), p_member_id: id, p_is_active: active });
      if (error) throw error;
      await loadMembers();
      await loadTasks();
    } catch (error) { $("memberMessage").textContent = rpcErrorText(error); }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
      if (!document.hidden && !$("taskApp").classList.contains("hidden")) loadAll();
    }, Math.max(5000, Number(cfg.POLL_INTERVAL_MS || 5000)));
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function bind() {
    $$(".module-tab").forEach(btn => btn.addEventListener("click", () => setModule(btn.dataset.module)));
    $("currentMemberSelect").addEventListener("change", e => {
      currentMemberId = e.target.value;
      localStorage.setItem(CURRENT_MEMBER_KEY, currentMemberId);
      if (currentMemberId) $("taskAssignee").value = currentMemberId;
    });
    $("taskAddBtn").addEventListener("click", addTask);
    $("taskTitle").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addTask(); } });
    $("taskRefreshBtn").addEventListener("click", loadAll);
    $("memberManageBtn").addEventListener("click", () => { renderMemberManage(); $("memberOverlay").classList.remove("hidden"); });
    $("memberCloseBtn").addEventListener("click", () => $("memberOverlay").classList.add("hidden"));
    $("memberAddBtn").addEventListener("click", addMember);
    $("newMemberName").addEventListener("keydown", e => { if (e.key === "Enter") addMember(); });
    $("taskEditCloseBtn").addEventListener("click", closeEdit);
    $("taskEditCancelBtn").addEventListener("click", closeEdit);
    $("taskEditForm").addEventListener("submit", e => { e.preventDefault(); saveEdit(); });
    $("taskDeleteBtn").addEventListener("click", deleteTask);
  }

  function start() {
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY || !window.supabase) return;
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    bind();
    // 첫 화면은 매출. 사용자가 업무공유를 선택하면 그때 데이터를 읽는다.
    setModule("sales");
  }

  start();
})();
