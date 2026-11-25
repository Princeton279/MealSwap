// MealSwap browser code. Each function has one clear job.
let currentUser = null;
let authMode = "login";
let scanner = null;

const $ = (id) => document.getElementById(id);

// Send requests to our own server and show useful errors.
async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 3000);
}

function showAuth(mode) {
  authMode = mode;
  $("auth-title").textContent = mode === "login" ? "Log in" : "Create your account";
  $("auth-submit").textContent = mode === "login" ? "Log in" : "Create account";
  $("name-field").classList.toggle("hidden", mode === "login");
  $("auth-switch").innerHTML = mode === "login"
    ? 'New here? <button type="button" onclick="showAuth(\\'register\\')">Create an account</button>'
    : 'Already registered? <button type="button" onclick="showAuth(\\'login\\')">Log in</button>';
  $("auth-modal").classList.remove("hidden");
}

function closeAuth() {
  $("auth-modal").classList.add("hidden");
  $("auth-form").reset();
}

function closeQr() {
  $("qr-modal").classList.add("hidden");
}

function updateAccountArea() {
  const area = $("account-area");
  if (!currentUser) {
    area.innerHTML = '<button class="button button-light" onclick="showAuth(\\'login\\')">Log in</button><button class="button button-primary" onclick="showAuth(\\'register\\')">Sign up</button>';
    $("admin-section").classList.add("hidden");
    return;
  }

  area.innerHTML = `<span class="welcome-user">Hi, ${escapeHtml(currentUser.name)}</span><button class="button button-light" onclick="logout()">Log out</button>`;
  $("admin-section").classList.toggle("hidden", currentUser.role !== "mess_admin");
}

// Escape user-written text before placing it into HTML.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[char]));
}

async function checkLogin() {
  try {
    const data = await api("/api/me");
    currentUser = data.user;
    updateAccountArea();
    if (currentUser) loadBookings();
  } catch (error) {
    showToast(error.message);
  }
}

$("auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const details = Object.fromEntries(form.entries());
  const endpoint = authMode === "login" ? "/api/login" : "/api/register";

  try {
    const data = await api(endpoint, { method: "POST", body: JSON.stringify(details) });
    currentUser = data.user;
    updateAccountArea();
    closeAuth();
    showToast("Welcome to MealSwap!");
    loadBookings();
  } catch (error) {
    showToast(error.message);
  }
});

async function logout() {
  await api("/api/logout", { method: "POST", body: "{}" });
  currentUser = null;
  updateAccountArea();
  $("booking-list").innerHTML = '<div class="empty-state">Log in to view your bookings.</div>';
  showToast("You are logged out.");
}

async function loadMeals() {
  const container = $("meal-list");
  try {
    const data = await api("/api/meals");
    if (!data.meals.length) {
      container.innerHTML = '<div class="empty-state">No meals listed right now. Be the first to share one!</div>';
      return;
    }

    container.innerHTML = data.meals.map((meal) => `
      <article class="meal-card">
        <div class="meal-top"><span class="meal-type">${escapeHtml(meal.meal_type)}</span><span class="meal-price">₹${Number(meal.price).toFixed(0)}</span></div>
        <h3>${escapeHtml(meal.title)}</h3>
        <div class="meal-meta">
          <span>📅 ${escapeHtml(meal.meal_date)} · ${escapeHtml(meal.meal_time)}</span>
          <span>📍 ${escapeHtml(meal.location)}</span>
          <span>📝 ${escapeHtml(meal.description || "No extra details")}</span>
        </div>
        <div class="meal-seller">Shared by ${escapeHtml(meal.seller_name)}</div>
        <button class="button button-primary button-full" onclick="bookMeal(${meal.id})">Book this meal</button>
      </article>
    `).join("");
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

async function bookMeal(id) {
  if (!currentUser) {
    showAuth("login");
    showToast("Log in before booking a meal.");
    return;
  }
  if (!confirm("Book this meal? You will receive a QR pass.")) return;

  try {
    const result = await api(`/api/meals/${id}/book`, { method: "POST", body: "{}" });
    showToast(result.message);
    await loadMeals();
    await loadBookings();
    // Find the new booking and display its QR.
    showQr(result.bookingId);
  } catch (error) {
    showToast(error.message);
  }
}

$("meal-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser) {
    showAuth("login");
    showToast("Log in before listing a meal.");
    return;
  }

  const details = Object.fromEntries(new FormData(event.target).entries());
  try {
    await api("/api/meals", { method: "POST", body: JSON.stringify(details) });
    event.target.reset();
    showToast("Your meal is now listed!");
    loadMeals();
  } catch (error) {
    showToast(error.message);
  }
});

async function loadBookings() {
  if (!currentUser) return;
  try {
    const data = await api("/api/bookings");
    if (!data.bookings.length) {
      $("booking-list").innerHTML = '<div class="empty-state">No bookings yet. Book a meal or list one to get started.</div>';
      return;
    }

    $("booking-list").innerHTML = data.bookings.map((booking) => `
      <article class="booking-card">
        <div>
          <h3>${escapeHtml(booking.title)} <span class="meal-type">${escapeHtml(booking.meal_type)}</span></h3>
          <p>${booking.my_role === "buyer" ? "You booked this meal" : "You listed this meal"} · ${escapeHtml(booking.meal_date)} at ${escapeHtml(booking.meal_time)}<br>
          ₹${Number(booking.price).toFixed(0)} · ${escapeHtml(booking.location)} · ${booking.my_role === "buyer" ? "Seller: " + escapeHtml(booking.seller_name) : "Buyer: " + escapeHtml(booking.buyer_name)}</p>
        </div>
        <div>
          <span class="status">${booking.status === "redeemed" ? "USED" : "ACTIVE"}</span>
          ${booking.my_role === "buyer" && booking.status === "active" ? `<button class="button button-outline" onclick="showQr(${booking.id})">Show QR</button>` : ""}
        </div>
      </article>
    `).join("");
  } catch (error) {
    showToast(error.message);
  }
}

async function showQr(bookingId) {
  try {
    const data = await api(`/api/bookings/${bookingId}/qr`);
    $("qr-image").src = data.qr;
    $("qr-modal").classList.remove("hidden");
  } catch (error) {
    showToast(error.message);
  }
}

async function redeemToken() {
  const token = $("qr-token").value.trim();
  const resultBox = $("scan-result");
  try {
    const data = await api("/api/admin/redeem", {
      method: "POST",
      body: JSON.stringify({ token })
    });
    resultBox.className = "notice";
    resultBox.textContent = `${data.message} Buyer: ${data.booking.buyer} · ${data.booking.title}`;
    $("qr-token").value = "";
    loadMeals();
    loadBookings();
  } catch (error) {
    resultBox.className = "notice error";
    resultBox.textContent = error.message;
  }
}

async function startScanner() {
  if (typeof Html5Qrcode === "undefined") {
    showToast("Camera scanner library could not load. Paste the QR token instead.");
    return;
  }
  try {
    if (!scanner) scanner = new Html5Qrcode("reader");
    await scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      async (decodedText) => {
        $("qr-token").value = decodedText;
        await scanner.stop();
        redeemToken();
      },
      () => {}
    );
  } catch (error) {
    showToast("Could not open camera. Allow camera access or use HTTPS.");
  }
}

// Set the date field to today to make listing quicker.
const dateInput = document.querySelector('input[name="date"]');
if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);

checkLogin();
loadMeals();
