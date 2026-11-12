/* TechStore: theme switch, toast notifications, confirm dialog, admin table helpers */
(function () {
    "use strict";

    // ---------- Theme (night mode) ----------
    const THEME_KEY = "tvstore-theme";
    function applyTheme(theme) {
        document.documentElement.setAttribute("data-bs-theme", theme);
        try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* private mode */ }
    }
    document.addEventListener("click", e => {
        const btn = e.target.closest("[data-theme-toggle]");
        if (!btn) return;
        const next = document.documentElement.getAttribute("data-bs-theme") === "dark" ? "light" : "dark";
        applyTheme(next);
    });

    // ---------- Toasts ----------
    const ICONS = { success: "bi-check-circle-fill", error: "bi-exclamation-octagon-fill", warning: "bi-exclamation-triangle-fill", info: "bi-info-circle-fill" };
    function stack() {
        let el = document.getElementById("toast-stack");
        if (!el) {
            el = document.createElement("div");
            el.id = "toast-stack";
            el.className = "toast-stack";
            el.setAttribute("aria-live", "polite");
            document.body.appendChild(el);
        }
        return el;
    }

    /** Shows a toast for ~2.8 s. type: success | error | warning | info */
    function notify(message, type = "success", duration = 2800) {
        if (!message) return;
        const toast = document.createElement("div");
        toast.className = `app-toast ${type}`;
        toast.setAttribute("role", type === "error" ? "alert" : "status");

        const icon = document.createElement("i");
        icon.className = `bi ${ICONS[type] || ICONS.info} t-icon`;
        const text = document.createElement("div");
        text.className = "t-text";
        text.textContent = message;
        const close = document.createElement("button");
        close.className = "t-close";
        close.type = "button";
        close.setAttribute("aria-label", "Close");
        close.innerHTML = "&times;";

        toast.append(icon, text, close);
        stack().appendChild(toast);
        requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add("show")));

        let timer = setTimeout(dismiss, duration);
        toast.addEventListener("mouseenter", () => clearTimeout(timer));
        toast.addEventListener("mouseleave", () => { timer = setTimeout(dismiss, 1200); });
        close.addEventListener("click", dismiss);

        function dismiss() {
            clearTimeout(timer);
            toast.classList.add("hide");
            toast.classList.remove("show");
            setTimeout(() => toast.remove(), 400);
        }
    }

    /** Remembers a toast to show after the next page load (for actions followed by reload/redirect) */
    function notifyAfterReload(message, type = "success") {
        try { sessionStorage.setItem("tvstore-toast", JSON.stringify({ message, type })); } catch (e) { /* ignore */ }
    }

    document.addEventListener("DOMContentLoaded", () => {
        // Flash message from the server (set by a redirecting route)
        const flash = document.getElementById("flash-data");
        if (flash && flash.dataset.message) notify(flash.dataset.message, flash.dataset.type || "success");

        // Toast queued by the previous page
        try {
            const saved = sessionStorage.getItem("tvstore-toast");
            if (saved) {
                sessionStorage.removeItem("tvstore-toast");
                const { message, type } = JSON.parse(saved);
                notify(message, type);
            }
        } catch (e) { /* ignore */ }

        initTables();
        initGallery();
    });

    // ---------- Confirm dialog (Bootstrap modal, falls back to window.confirm) ----------
    function confirmDialog({ title = "Are you sure?", message = "", confirmText = "Confirm", danger = true } = {}) {
        if (!window.bootstrap) return Promise.resolve(window.confirm(message || title));
        return new Promise(resolve => {
            const wrap = document.createElement("div");
            wrap.className = "modal fade";
            wrap.tabIndex = -1;
            wrap.innerHTML = `
                <div class="modal-dialog modal-dialog-centered">
                  <div class="modal-content p-2">
                    <div class="modal-body">
                      <h5 class="mb-2"></h5>
                      <p class="text-muted mb-0"></p>
                    </div>
                    <div class="modal-footer border-0 pt-0">
                      <button type="button" class="btn btn-ghost" data-bs-dismiss="modal">Cancel</button>
                      <button type="button" class="btn ${danger ? "btn-danger" : "btn-brand"}" data-ok></button>
                    </div>
                  </div>
                </div>`;
            wrap.querySelector("h5").textContent = title;
            wrap.querySelector("p").textContent = message;
            wrap.querySelector("[data-ok]").textContent = confirmText;
            document.body.appendChild(wrap);
            const modal = new bootstrap.Modal(wrap);
            let result = false;
            wrap.querySelector("[data-ok]").addEventListener("click", () => { result = true; modal.hide(); });
            wrap.addEventListener("hidden.bs.modal", () => { wrap.remove(); resolve(result); });
            modal.show();
        });
    }

    // Forms with data-confirm="message" ask before submitting
    document.addEventListener("submit", async e => {
        const form = e.target;
        if (!form.matches("form[data-confirm]") || form.dataset.confirmed) return;
        e.preventDefault();
        const ok = await confirmDialog({
            title: form.dataset.confirmTitle || "Are you sure?",
            message: form.dataset.confirm,
            confirmText: form.dataset.confirmButton || "Confirm",
            danger: form.dataset.confirmDanger !== "false"
        });
        if (ok) { form.dataset.confirmed = "1"; form.submit(); }
    });

    // Disable submit buttons after the first click, so a slow request can't be sent twice
    document.addEventListener("submit", e => {
        const form = e.target;
        if (e.defaultPrevented || form.hasAttribute("data-no-lock")) return;
        setTimeout(() => {
            if (e.defaultPrevented) return;
            form.querySelectorAll("button[type=submit], button:not([type])").forEach(b => {
                b.disabled = true;
                if (b.dataset.loadingText) b.textContent = b.dataset.loadingText;
            });
        }, 0);
    });

    // ---------- Admin tables: search + pagination + "changed" highlight ----------
    function initTables() {
        document.querySelectorAll("[data-table]").forEach(table => {
            const tbody = table.tBodies[0];
            if (!tbody) return;
            const rows = Array.from(tbody.rows);
            const pageSize = parseInt(table.dataset.pageSize || "20", 10);
            const searchInput = document.querySelector(`[data-table-search="${table.id}"]`);
            const pager = document.querySelector(`[data-table-pager="${table.id}"]`);
            let page = 1;
            let visible = rows;

            const rowText = row => Array.from(row.cells).map(c => {
                const field = c.querySelector("input, textarea, select");
                return field ? field.value : c.textContent;
            }).join(" ").toLowerCase();

            function render() {
                const pages = Math.max(1, Math.ceil(visible.length / pageSize));
                page = Math.min(page, pages);
                rows.forEach(r => { r.hidden = true; });
                visible.slice((page - 1) * pageSize, page * pageSize).forEach(r => { r.hidden = false; });
                if (pager) {
                    const from = visible.length ? (page - 1) * pageSize + 1 : 0;
                    const to = Math.min(page * pageSize, visible.length);
                    pager.innerHTML = `
                        <span>${from}–${to} of ${visible.length}</span>
                        <span class="d-flex gap-2">
                          <button type="button" class="btn btn-outline-brand btn-sm" data-p="prev" ${page <= 1 ? "disabled" : ""}><i class="bi bi-chevron-left"></i></button>
                          <span class="align-self-center">Page ${page} / ${pages}</span>
                          <button type="button" class="btn btn-outline-brand btn-sm" data-p="next" ${page >= pages ? "disabled" : ""}><i class="bi bi-chevron-right"></i></button>
                        </span>`;
                }
            }

            if (pager) pager.addEventListener("click", e => {
                const b = e.target.closest("[data-p]");
                if (!b) return;
                page += b.dataset.p === "next" ? 1 : -1;
                render();
            });
            if (searchInput) searchInput.addEventListener("input", () => {
                const q = searchInput.value.trim().toLowerCase();
                visible = q ? rows.filter(r => rowText(r).includes(q)) : rows;
                page = 1;
                render();
            });
            tbody.addEventListener("input", e => {
                const row = e.target.closest("tr");
                if (row) row.classList.add("dirty");
            });
            render();
        });
    }

    // ---------- Product gallery ----------
    function initGallery() {
        const main = document.getElementById("gallery-main-img");
        if (!main) return;
        document.querySelectorAll("[data-gallery-thumb]").forEach(btn => {
            btn.addEventListener("click", () => {
                document.querySelectorAll("[data-gallery-thumb]").forEach(b => b.classList.remove("active"));
                btn.classList.add("active");
                main.style.opacity = "0";
                setTimeout(() => { main.src = btn.dataset.src; main.style.opacity = "1"; }, 150);
            });
        });
    }

    window.TVStore = { notify, notifyAfterReload, confirmDialog, applyTheme };
})();
