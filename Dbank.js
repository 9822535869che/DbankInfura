/* =====================================================================
   ตั้งค่าตรงนี้ที่เดียว
   ===================================================================== */
const CONFIG = {
    STUDENT_ID:        "66087954",
    STUDENT_NAME:      "เมธาพร ทองนาค",

    // สมัครฟรีที่ infura.io แล้วนำ API Key (Project ID) มาวางแทนข้อความด้านล่าง
    INFURA_PROJECT_ID: "YOUR_INFURA_PROJECT_ID",

    // Address ของ Smart Contract ธนาคารที่ Deploy บน Sepolia
    CONTRACT_ADDRESS:  "0xE1C4F0a5917d74269A42cEfCDFf4C21b24675980",

    // เลขบล็อกที่ Deploy (ใช้ค้นประวัติย้อนหลัง) ใส่ให้น้อยกว่าหรือเท่าบล็อก Deploy
    // ตอนนี้เป็นค่าประมาณที่ปลอดภัย (ก่อน Deploy ราว 1 วันครึ่ง) ถ้ารู้เลขบล็อกจริงจาก Etherscan ให้ใส่แทน
    DEPLOY_BLOCK:      12180000,

    CHAIN_ID:          11155111,            // Sepolia
    EXPLORER:          "https://sepolia.etherscan.io"
};

const INFURA_URL = "https://sepolia.infura.io/v3/" + CONFIG.INFURA_PROJECT_ID;
const HAS_INFURA = !!CONFIG.INFURA_PROJECT_ID && CONFIG.INFURA_PROJECT_ID !== "YOUR_INFURA_PROJECT_ID";

// ABI รองรับทั้ง checkBlance (ตามโจทย์) และ checkBalance (สะกดถูก)
const ABI = [
    { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
    { type: "function", name: "withdraw", stateMutability: "nonpayable",
      inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
    { type: "function", name: "checkBlance", stateMutability: "view",
      inputs: [], outputs: [{ name: "", type: "uint256" }] },
    { type: "function", name: "checkBalance", stateMutability: "view",
      inputs: [], outputs: [{ name: "", type: "uint256" }] }
];

// Event ของ contract มี 2 แบบ (ตามโจทย์: 2 พารามิเตอร์ / Dbank.sol: 3 พารามิเตอร์)
const EVENT_TYPES = {};
(function buildTopics() {
    ["Deposit", "Withdraw"].forEach(function (name) {
        ["(address,uint256)", "(address,uint256,uint256)"].forEach(function (args) {
            EVENT_TYPES[Web3.utils.keccak256(name + args)] = name;
        });
    });
})();


/* =====================================================================
   ตัวแปรและตัวช่วย
   ===================================================================== */
const $ = function (id) { return document.getElementById(id); };

let readWeb3 = null;        // อ่านข้อมูลผ่าน Infura (HttpProvider)
let walletWeb3 = null;      // เซ็นธุรกรรมผ่าน MetaMask
let readContract = null;
let walletContract = null;
let ethProvider = null;     // window.ethereum ของ MetaMask
let account = null;
let balanceFn = null;       // ชื่อฟังก์ชันเช็กยอดที่ใช้ได้กับ contract นี้
let busy = false;
const sessionRows = {};     // ธุรกรรมที่ทำในหน้านี้ (แสดงทันทีก่อน Infura ดึง event ได้)

function short(addr) { return addr.slice(0, 6) + "..." + addr.slice(-4); }

function fmtEth(wei) {
    const s = Web3.utils.fromWei(String(wei), "ether");
    const parts = s.split(".");
    const frac = (parts[1] || "").slice(0, 6).replace(/0+$/, "").padEnd(4, "0");
    return parts[0] + "." + frac;
}

function showStatus(message, type) {
    $("statusMessage").textContent = message;
    $("statusMessage").className = "status-message " + (type || "");

    let toast = $("toast");
    if (!toast) {
        toast = document.createElement("div");
        toast.id = "toast";
        toast.style.cssText =
            "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);" +
            "max-width:90vw;padding:14px 22px;border-radius:14px;color:#fff;" +
            "font:500 15px Prompt,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.2);" +
            "z-index:9999;transition:opacity .3s;";
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.background = type === "error" ? "#e63946" : "#16a36a";
    toast.style.opacity = "1";
    clearTimeout(showStatus.timer);
    showStatus.timer = setTimeout(function () { toast.style.opacity = "0"; }, 6000);
}

function setPill(name, state, text) {
    $("dot" + name).className = "dot " + state;
    $("txt" + name).textContent = text;
}

function explain(e) {
    const m = String((e && (e.message || e.reason)) || e || "");
    if ((e && e.code === 4001) || /User denied|User rejected|rejected the request/i.test(m)) return "คุณปฏิเสธธุรกรรมใน MetaMask";
    if (e && e.code === -32002) return "มีคำขอค้างอยู่ใน MetaMask กรุณาเปิดไอคอน MetaMask แล้วกดอนุมัติ";
    if (/not enough money|Insufficient balance/i.test(m)) return "ยอดเงินในธนาคารไม่พอสำหรับถอน";
    if (/reverted by the EVM|execution reverted|reverted/i.test(m)) {
        return "ธุรกรรมถูกปฏิเสธโดย Smart Contract (reverted) ถ้ากด Withdraw ให้เช็กว่าจำนวนไม่เกิน Bank Balance " +
               "ถ้ากด Deposit ให้เช็กว่าจำนวนมากกว่า 0 และตรวจว่า CONTRACT_ADDRESS ถูกต้องบนเครือข่าย Sepolia";
    }
    if (/Deposit money is zero|greater than zero/i.test(m)) return "จำนวนเงินต้องมากกว่า 0";
    if (/insufficient funds/i.test(m)) return "ETH ใน Wallet ไม่พอสำหรับค่า Gas หรือยอดที่ฝาก";
    if (/too many decimal|Invalid number/i.test(m)) return "จำนวน ETH ไม่ถูกต้อง (ทศนิยมได้ไม่เกิน 18 ตำแหน่ง)";
    return m.split("\n")[0].slice(0, 220) || "เกิดข้อผิดพลาด";
}

function setBusy(value) {
    busy = value;
    ["depositBtn", "withdrawBtn", "checkBalanceBtn"].forEach(function (id) { $(id).disabled = value; });
}


/* =====================================================================
   1) ตั้งค่าข้อมูลบนหน้าเว็บ + เชื่อม Infura + ตรวจ Smart Contract
   ===================================================================== */
function renderStatic() {
    $("studentId").textContent = $("profileId").textContent = CONFIG.STUDENT_ID;
    $("studentName").textContent = $("profileName").textContent = CONFIG.STUDENT_NAME;

    const link = $("contractLink");
    link.textContent = CONFIG.CONTRACT_ADDRESS;
    link.href = CONFIG.EXPLORER + "/address/" + CONFIG.CONTRACT_ADDRESS;
}

async function verifyContract(w3) {
    const code = await w3.eth.getCode(CONFIG.CONTRACT_ADDRESS);
    if (!code || code === "0x" || code === "0x0") {
        throw new Error("ไม่พบ Smart Contract ที่ address นี้บนเครือข่ายปัจจุบัน");
    }
}

async function initInfura() {
    if (!HAS_INFURA) {
        setPill("Infura", "warn", "ยังไม่ได้ใส่ Infura Project ID ใน CONFIG ตอนนี้อ่านข้อมูลผ่าน MetaMask แทน");
        return;
    }
    try {
        // ตามสไลด์: web3 = new Web3(new Web3.providers.HttpProvider(INFURA_URL))
        const w3 = new Web3(new Web3.providers.HttpProvider(INFURA_URL));
        const chainId = Number(await w3.eth.getChainId());
        if (chainId !== CONFIG.CHAIN_ID) throw new Error("Infura ไม่ใช่เครือข่าย Sepolia");
        const block = await w3.eth.getBlockNumber();

        readWeb3 = w3;
        // ตามสไลด์: contract = new web3.eth.Contract(abi, contractAddress)
        readContract = new w3.eth.Contract(ABI, CONFIG.CONTRACT_ADDRESS);
        setPill("Infura", "ok", "เชื่อมต่อแล้ว · Sepolia · block " + block);

        await verifyContract(w3);
        setPill("Contract", "ok", "เชื่อมต่อ Smart Contract สำเร็จ (ตรวจผ่าน Infura)");
    } catch (e) {
        console.error("Infura error:", e);
        readWeb3 = null;
        readContract = null;
        setPill("Infura", "err", "เชื่อมต่อ Infura ไม่ได้ ตรวจ Project ID หรืออินเทอร์เน็ต (" + explain(e) + ")");
    }
}


/* =====================================================================
   2) MetaMask
   ===================================================================== */
function pickInjected() {
    const eth = window.ethereum;
    if (!eth) return null;
    if (Array.isArray(eth.providers) && eth.providers.length) {
        return eth.providers.find(function (p) { return p.isMetaMask; }) || eth.providers[0];
    }
    return eth;
}

async function getEthProvider() {
    for (let i = 0; i < 15; i++) {       // รอ MetaMask ฉีดตัวแปรได้สูงสุด ~1.5 วินาที
        if (!ethProvider) ethProvider = pickInjected();
        if (ethProvider) break;
        await new Promise(function (r) { setTimeout(r, 100); });
    }
    return ethProvider;
}

async function ensureSepolia() {
    const hex = await ethProvider.request({ method: "eth_chainId" });
    if (parseInt(hex, 16) === CONFIG.CHAIN_ID) return;
    try {
        await ethProvider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x" + CONFIG.CHAIN_ID.toString(16) }]
        });
    } catch (e) {
        throw new Error("กรุณาสลับ MetaMask ไปเครือข่าย Sepolia แล้วลองใหม่");
    }
}

async function connectWallet() {
    try {
        if (!window.Web3) throw new Error("โหลดไลบรารี Web3.js ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วรีเฟรช");

        const injected = await getEthProvider();
        if (!injected) {
            let msg = "ไม่พบ MetaMask ในหน้านี้";
            if (location.protocol === "file:") {
                msg += " (เปิดแบบ file:// MetaMask มักไม่ทำงาน ให้เปิดผ่าน http://localhost หรือลิงก์ GitHub Pages)";
            }
            throw new Error(msg);
        }

        showStatus("กำลังเชื่อมต่อ... กรุณากดอนุมัติใน MetaMask", "success");
        const accounts = await injected.request({ method: "eth_requestAccounts" });
        if (!accounts.length) throw new Error("ไม่พบบัญชี Wallet");

        await ensureSepolia();
        await onConnected(accounts[0]);
        showStatus("เชื่อมต่อ MetaMask สำเร็จ", "success");
    } catch (e) {
        console.error("Connect error:", e);
        showStatus(explain(e), "error");
    }
}

async function onConnected(addr) {
    account = addr;
    walletWeb3 = new Web3(ethProvider);
    walletContract = new walletWeb3.eth.Contract(ABI, CONFIG.CONTRACT_ADDRESS);

    $("walletAddress").textContent = short(addr);
    $("walletAddressCard").textContent = short(addr);
    $("walletArrow").textContent = "✓";
    setPill("Wallet", "ok", "เชื่อมต่อแล้ว · " + addr);

    if (!readWeb3) {                       // ไม่มี Infura ใช้ MetaMask ตรวจ contract แทน
        try {
            await verifyContract(walletWeb3);
            setPill("Contract", "ok", "เชื่อมต่อ Smart Contract สำเร็จ (ตรวจผ่าน MetaMask)");
        } catch (e) {
            setPill("Contract", "err", explain(e));
        }
    }
    await refreshAll();
}

function onDisconnected() {
    account = null; walletWeb3 = null; walletContract = null;
    $("walletAddress").textContent = "Connect Wallet";
    $("walletAddressCard").textContent = "Not Connected";
    $("walletArrow").textContent = "➜";
    $("balance").textContent = "0.0000";
    $("bankBalance").textContent = "-";
    $("networkInfo").textContent = "Network: -";
    setPill("Wallet", "", "ยังไม่ได้เชื่อมต่อ กดปุ่ม Connect Wallet");
    $("transactionList").innerHTML = "<div class='empty-transaction'>เชื่อมต่อ Wallet เพื่อดูประวัติ</div>";
}

function attachWalletEvents() {
    if (!ethProvider || attachWalletEvents.done) return;
    attachWalletEvents.done = true;
    ethProvider.on("accountsChanged", function (accounts) {
        if (!accounts.length) { onDisconnected(); showStatus("Wallet disconnected", "error"); }
        else { onConnected(accounts[0]).then(function () { showStatus("เปลี่ยน Wallet Account สำเร็จ", "success"); }); }
    });
    ethProvider.on("chainChanged", function () { window.location.reload(); });
}


/* =====================================================================
   3) อ่านข้อมูล (Call - ไม่เสียค่า Gas)
   ===================================================================== */
async function refreshWalletBalance() {
    const w3 = readWeb3 || walletWeb3;
    const wei = await w3.eth.getBalance(account);
    $("balance").textContent = fmtEth(wei);
    $("networkInfo").textContent = "Network: Sepolia (Chain ID: " + CONFIG.CHAIN_ID + ") · อ่านผ่าน " + (readWeb3 ? "Infura" : "MetaMask");
}

async function readBankBalance() {
    const c = readContract || walletContract;
    const names = balanceFn ? [balanceFn] : ["checkBlance", "checkBalance"];
    let lastError;
    for (const name of names) {
        try {
            // checkBlance ใช้ msg.sender จึงต้องระบุ from เป็น Wallet ของผู้ใช้
            const value = await c.methods[name]().call({ from: account });
            balanceFn = name;
            return value;
        } catch (e) { lastError = e; }
    }
    throw lastError;
}

async function refreshBankBalance() {
    const value = await readBankBalance();
    $("bankBalance").textContent = fmtEth(value);
    return value;
}

async function loadHistory() {
    if (!account) return;
    const w3 = readWeb3 || walletWeb3;
    const padded = Web3.utils.padLeft(account.toLowerCase(), 64);
    const query = function (fromBlock) {
        return w3.eth.getPastLogs({
            address: CONFIG.CONTRACT_ADDRESS,
            fromBlock: fromBlock,
            toBlock: "latest",
            topics: [Object.keys(EVENT_TYPES), padded]
        });
    };

    let logs;
    try {
        logs = await query(CONFIG.DEPLOY_BLOCK);
    } catch (e) {                          // ช่วงบล็อกใหญ่เกินไป ลองเฉพาะ 50,000 บล็อกล่าสุด
        const latest = await w3.eth.getBlockNumber();
        logs = await query(Math.max(CONFIG.DEPLOY_BLOCK, latest - 50000));
    }

    const rows = logs.map(function (lg) {
        return {
            type: EVENT_TYPES[lg.topics[0]],
            amount: fmtEth(Web3.utils.hexToNumberString("0x" + lg.data.slice(2, 66))),
            hash: lg.transactionHash,
            block: Number(lg.blockNumber),
            status: "Success"
        };
    }).sort(function (a, b) { return b.block - a.block; });

    const known = {};
    rows.forEach(function (r) { known[r.hash.toLowerCase()] = true; });
    const extra = Object.keys(sessionRows).filter(function (h) { return !known[h.toLowerCase()]; })
        .map(function (h) { return sessionRows[h]; }).reverse();

    renderHistory(extra.concat(rows));
}

function renderHistory(rows) {
    const box = $("transactionList");
    box.innerHTML = "";
    if (!rows.length) {
        box.innerHTML = "<div class='empty-transaction'>No transactions yet</div>";
        return;
    }
    rows.forEach(function (r) {
        const row = document.createElement("div");
        row.className = "table-row";

        const type = document.createElement("span"); type.textContent = r.type;
        const amt = document.createElement("span"); amt.textContent = r.amount + " ETH";
        const hash = document.createElement("span");
        const a = document.createElement("a");
        a.href = CONFIG.EXPLORER + "/tx/" + r.hash; a.target = "_blank"; a.rel = "noopener";
        a.textContent = r.hash.slice(0, 10) + "..." + r.hash.slice(-6);
        if (r.block) a.title = "Block " + r.block;
        hash.appendChild(a);
        const st = document.createElement("span");
        st.textContent = r.status;
        st.className = r.status === "Success" ? "st-ok" : (r.status === "Failed" ? "st-fail" : "st-pending");

        [type, amt, hash, st].forEach(function (el) { row.appendChild(el); });
        box.appendChild(row);
    });
}

async function refreshAll() {
    const results = await Promise.allSettled([refreshWalletBalance(), refreshBankBalance(), loadHistory()]);
    results.forEach(function (r) { if (r.status === "rejected") console.warn("refresh:", r.reason); });
}


/* =====================================================================
   4) ปุ่ม Deposit / Withdraw / Check Balance
   ===================================================================== */
function requireReady() {
    if (!account || !walletContract) throw new Error("กรุณากดปุ่ม Connect Wallet ก่อน");
}

function readAmountWei() {
    const raw = $("amount").value.trim();
    if (!raw || !(Number(raw) > 0)) throw new Error("กรุณาใส่จำนวน ETH ที่มากกว่า 0");
    return Web3.utils.toWei(raw, "ether");
}

async function sendTx(type, wei, buildCall) {
    showStatus("กรุณายืนยันธุรกรรมใน MetaMask...", "success");
    let txHash = null;

    const renderSession = function () {
        renderHistory(Object.keys(sessionRows).map(function (h) { return sessionRows[h]; }).reverse());
    };

    let receipt;
    try {
        receipt = await buildCall()
            .on("transactionHash", function (hash) {
                txHash = hash;
                sessionRows[hash] = { type: type, amount: fmtEth(wei), hash: hash, block: 0, status: "Pending" };
                renderSession();
                showStatus("ส่งธุรกรรมแล้ว รอการยืนยันบนบล็อกเชน... (Pending)", "success");
            });
    } catch (e) {
        // ธุรกรรมถูกส่งแล้วแต่ล้มเหลว (reverted) ให้เปลี่ยนสถานะเป็น Failed ไม่ค้างเป็น Pending
        if (txHash && sessionRows[txHash]) {
            sessionRows[txHash].status = "Failed";
            renderSession();
        }
        throw e;
    }

    if (txHash) {
        sessionRows[txHash].status = receipt.status ? "Success" : "Failed";
        sessionRows[txHash].block = Number(receipt.blockNumber);
    }
    await Promise.allSettled([refreshWalletBalance(), refreshBankBalance()]);
    await loadHistory();
    return !!receipt.status;
}

async function onDeposit() {
    if (busy) return;
    setBusy(true);
    try {
        requireReady();
        const wei = readAmountWei();
        // ฝากเงิน: ส่ง ETH ไปกับ msg.value ของ deposit()
        const ok = await sendTx("Deposit", wei, function () {
            return walletContract.methods.deposit().send({ from: account, value: wei });
        });
        showStatus(ok ? "ฝากเงินสำเร็จ (Success!)" : "ธุรกรรมล้มเหลว", ok ? "success" : "error");
    } catch (e) {
        console.error("Deposit error:", e);
        showStatus(explain(e), "error");
    } finally { setBusy(false); }
}

async function onWithdraw() {
    if (busy) return;
    setBusy(true);
    try {
        requireReady();
        const wei = readAmountWei();
        const bank = await readBankBalance();      // เช็กยอดก่อน จะได้ไม่เสียค่า Gas กับธุรกรรมที่ต้องล้มเหลว
        if (BigInt(wei) > BigInt(bank)) {
            throw new Error("ยอดเงินในธนาคารไม่พอ (มี " + fmtEth(bank) + " ETH) กรุณา Deposit ก่อน หรือถอนไม่เกินยอดนี้");
        }
        const ok = await sendTx("Withdraw", wei, function () {
            return walletContract.methods.withdraw(wei).send({ from: account });
        });
        showStatus(ok ? "ถอนเงินสำเร็จ (Success!)" : "ธุรกรรมล้มเหลว", ok ? "success" : "error");
    } catch (e) {
        console.error("Withdraw error:", e);
        showStatus(explain(e), "error");
    } finally { setBusy(false); }
}

async function onCheckBalance() {
    if (busy) return;
    setBusy(true);
    try {
        requireReady();
        const value = await refreshBankBalance();
        showStatus("ยอดคงเหลือในธนาคาร: " + fmtEth(value) + " ETH", "success");
    } catch (e) {
        console.error("Check balance error:", e);
        showStatus(explain(e), "error");
    } finally { setBusy(false); }
}


/* =====================================================================
   5) เริ่มต้นระบบ
   ===================================================================== */
$("connectWallet").addEventListener("click", connectWallet);
$("depositBtn").addEventListener("click", onDeposit);
$("withdrawBtn").addEventListener("click", onWithdraw);
$("checkBalanceBtn").addEventListener("click", onCheckBalance);
$("reloadHistory").addEventListener("click", function (e) {
    e.preventDefault();
    if (!account) return showStatus("กรุณากดปุ่ม Connect Wallet ก่อน", "error");
    loadHistory().catch(function (err) { showStatus(explain(err), "error"); });
});
$("copyAddress").addEventListener("click", function () {
    if (!account) return showStatus("กรุณาเชื่อมต่อ Wallet ก่อน", "error");
    navigator.clipboard.writeText(account).then(
        function () { showStatus("คัดลอก Wallet Address แล้ว", "success"); },
        function () { showStatus("ไม่สามารถคัดลอก Address ได้", "error"); });
});
$("copyContract").addEventListener("click", function () {
    navigator.clipboard.writeText(CONFIG.CONTRACT_ADDRESS).then(
        function () { showStatus("คัดลอก Contract Address แล้ว", "success"); },
        function () { showStatus("ไม่สามารถคัดลอก Address ได้", "error"); });
});

async function start() {
    renderStatic();

    if (!window.Web3) {
        setPill("Infura", "err", "โหลด Web3.js ไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วรีเฟรชหน้า");
        setPill("Contract", "err", "ยังตรวจสอบไม่ได้");
        showStatus("โหลดไลบรารี Web3.js ไม่สำเร็จ", "error");
        return;
    }

    await initInfura();
    if (!readWeb3) setPill("Contract", "warn", "รอเชื่อม Wallet เพื่อตรวจสอบ Smart Contract");

    const injected = await getEthProvider();
    if (!injected) {
        setPill("Wallet", "warn", location.protocol === "file:"
            ? "ไม่พบ MetaMask (เปิดแบบ file:// ให้เปิดผ่าน http://localhost หรือ GitHub Pages)"
            : "ไม่พบ MetaMask ในเบราว์เซอร์นี้");
        return;
    }
    attachWalletEvents();

    try {                                  // ถ้าเคยอนุญาตแล้ว เชื่อมให้อัตโนมัติ
        const accounts = await injected.request({ method: "eth_accounts" });
        if (accounts.length) {
            const hex = await injected.request({ method: "eth_chainId" });
            if (parseInt(hex, 16) === CONFIG.CHAIN_ID) await onConnected(accounts[0]);
            else setPill("Wallet", "warn", "MetaMask ไม่ได้อยู่บน Sepolia กด Connect Wallet เพื่อสลับเครือข่าย");
        }
    } catch (e) { console.warn("auto-connect:", e); }
}

start();
