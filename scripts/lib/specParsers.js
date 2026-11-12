/**
 * Extracts category specs from a feed offer. The shop.kz feed has no structured characteristics,
 * but product names follow a stable pattern per category, e.g.
 *   "Видеокарта ASUS RTX 5070 TUF Gaming OC Edition, 12 GB, GeForce RTX 5070"
 *   "DDR-5 DIMM 32 GB 6000 MHz Team Group T-Force Delta RGB, 2x 16 GB Kit, Black, BOX"
 *   "Блок питания ATX 850 W GameMax RGB-Smart 850 PRO"
 * Each parser returns a plain object; config/categories.js#cleanSpecs then enforces the types.
 * Offer: { name, description, vendor, params: { category } } (params.category = feed sub-category)
 */

const num = s => (s == null ? null : Number(String(s).replace(",", ".")));
const first = (text, re) => { const m = text.match(re); return m ? m[1] : null; };

// Size of a capacity written as "256 GB", "1 TB", "6144Mb", "16G", "2000G" -> GB
function capacityGB(value, unit) {
    const v = num(value);
    if (!Number.isFinite(v)) return null;
    const u = unit.toUpperCase();
    if (u.startsWith("T")) return v * 1000;
    if (u === "MB") return v >= 512 ? Math.round(v / 1024) : null;
    return v;
}

// Colour: the comma-separated part after the model that looks like a colour name
const COLOR_WORDS = /black|white|grey|gray|silver|blue|green|red|pink|purple|violet|gold|yellow|orange|teal|graphite|titanium|cyan|beige|ivory|mint|lavender|midnight|chrome|brown|чёрн|черн|бел|сер|син|красн|зел/i;
function color(name) {
    const parts = name.split(",").map(s => s.trim()).slice(1);
    const c = parts.find(p => COLOR_WORDS.test(p) && p.length <= 40 && !/\bGB\b|USB|Bluetooth|Switch|Cherry|\bMX\b|Outemu|Gateron|Kailh|Akko|TTC/i.test(p));
    return c ? c.replace(/\s*\(.*\)\s*$/, "") : null;
}

function connection(name) {
    if (/bluetooth|беспровод|wireless|\bWL\b|2[.,]4\s*G|радио/i.test(name)) return /bluetooth/i.test(name) && !/USB/i.test(name) ? "Bluetooth" : "Wireless";
    if (/USB|PS\/2|проводн|3[.,]5\s*мм|jack|Type-C/i.test(name)) return "Wired";
    return null;
}

const PARSERS = {
    phone(o) {
        const sizes = [...o.name.matchAll(/(\d{1,4})\s*(GB|TB)\b/gi)].map(m => capacityGB(m[1], m[2]));
        const ram = first(o.name, /(\d{1,2})\s*GB\s*RAM/i);
        const rom = first(o.name, /(\d{2,4})\s*GB\s*ROM/i);
        let ram_gb = ram ? num(ram) : null, storage_gb = rom ? num(rom) : null;
        if (!storage_gb && sizes.length) storage_gb = Math.max(...sizes);
        if (!ram_gb && sizes.length >= 2) ram_gb = Math.min(...sizes);
        return { storage_gb, ram_gb, color: color(o.name) };
    },

    tv(o) {
        const diagonal = num(first(o.name, /(\d{2,3})(?:[.,]\d)?\s*(?:"|”|″|''|дюйм)/i))
            ?? num(first(o.name, /(?:UE|QE|KD|XR|L|LTV|S)(\d{2})/i));
        const text = `${o.name} ${o.description || ""}`.toUpperCase();
        const panel = ["OLED", "NEO QLED", "QLED", "MINI LED", "LED"].find(t => text.includes(t));
        const PANELS = { "OLED": "OLED", "NEO QLED": "QLED", "QLED": "QLED", "MINI LED": "Mini LED", "LED": "LED" };
        return { diagonal: diagonal >= 19 && diagonal <= 120 ? diagonal : null, panel: panel ? PANELS[panel] : null };
    },

    gpu(o) {
        const n = o.name.replace(/[сС]/g, c => (c === "с" ? "c" : "C"));     // Cyrillic "с" inside "GeForсe"
        const mem = n.match(/(\d{1,5})\s*(GB|Gb|Mb|MB|G)\b/);
        let chip = null, chip_vendor = null;
        let m;
        if ((m = n.match(/\b(RTX|GTX)\s?(\d{3,4})\s?(Ti\s?Super|Ti|Super)?/i))) {
            chip = `${m[1].toUpperCase()} ${m[2]}${m[3] ? " " + m[3].replace(/\s+/, " ").replace(/^ti/i, "Ti").replace(/super/i, "Super") : ""}`;
            chip_vendor = "NVIDIA";
        } else if ((m = n.match(/\bGT\s?(\d{3,4})/i))) {
            chip = `GT ${m[1]}`; chip_vendor = "NVIDIA";
        } else if ((m = n.match(/\bRX\s?(\d{3,4})\s?(XTX|XT|GRE)?/i))) {
            chip = `RX ${m[1]}${m[2] ? " " + m[2].toUpperCase() : ""}`; chip_vendor = "AMD";
        } else if ((m = n.match(/\bArc\s?([AB]\d{3})/i))) {
            chip = `Arc ${m[1].toUpperCase()}`; chip_vendor = "Intel";
        } else if (/geforce/i.test(n)) chip_vendor = "NVIDIA";
        else if (/radeon/i.test(n)) chip_vendor = "AMD";
        return { chip, chip_vendor, memory_gb: mem ? capacityGB(mem[1], mem[2]) : null };
    },

    cpu(o) {
        const n = o.name;
        let series = null, m;
        if ((m = n.match(/Core\s+Ultra\s+(\d)/i))) series = `Core Ultra ${m[1]}`;
        else if ((m = n.match(/Core\s+(i\d)/i))) series = `Core ${m[1]}`;
        else if ((m = n.match(/Ryzen\s+(?:PRO\s+)?(\d)/i))) series = `Ryzen ${m[1]}`;
        else if ((m = n.match(/\b(Celeron|Pentium|Athlon|Threadripper|Xeon|EPYC)\b/i))) series = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
        else if (/\bAMD\s+A\d/i.test(n)) series = "AMD A-series";
        const socket = first(n, /\b(LGA\s?\d{4}|AM[45]|sTRX4|sTR5|SP[35]|FM2\+?)\b/i);
        return {
            series,
            socket: socket ? socket.toUpperCase().replace(/\s/g, "") : null,
            packaging: /\bBOX\b/i.test(n) ? "BOX" : /\bOEM\b|\bTray\b/i.test(n) ? "OEM" : null,
            cooler: /с кулером|with cooler|\bBOX\b/i.test(n)
        };
    },

    motherboard(o) {
        const n = o.name;
        const socket = first(n, /\b(LGA\s?\d{4}|AM[45]|sTRX4|sTR5)\b/i);
        const chipset = first(n, /\b([ABHQXZW]\d{3}[EM]?)(?=[\sM\-]|$)/);
        let s = socket ? socket.toUpperCase().replace(/\s/g, "") : null;
        if (!s && chipset) {            // chipset tells the platform when the socket is missing
            if (/^[ABX]6\d\d|^[ABX]8\d\d/.test(chipset)) s = "AM5";
            else if (/^[ABX][345]\d\d/.test(chipset)) s = "AM4";
            else if (/^[BHZ]8\d\d/.test(chipset)) s = "LGA1851";
            else if (/^[BHZ][67]\d\d/.test(chipset)) s = "LGA1700";
        }
        const memory = /DDR5|D5\b/i.test(n) ? "DDR5" : /DDR4|D4\b/i.test(n) ? "DDR4"
            : (s === "AM5" || s === "LGA1851") ? "DDR5" : s === "AM4" ? "DDR4" : null;
        // "B760M" = B760 chipset on a micro-ATX board: the chipset is what matters for the filter
        return { socket: s, chipset: chipset ? chipset.toUpperCase().replace(/M$/, "") : null, memory, wifi: /wi-?fi|\bAX\b|\bWIFI/i.test(n) };
    },

    ram(o) {
        const n = o.name;
        const type = first(n, /DDR-?(\d)/i);
        const kit = n.match(/(\d)\s?x\s?(\d{1,3})\s?GB/i);
        const cap = first(n, /(\d{1,3})\s?GB/i);
        return {
            type: type ? `DDR${type}` : null,
            capacity_gb: num(cap),
            speed_mhz: num(first(n, /(\d{4})\s?MHz/i)),
            modules: kit ? num(kit[1]) : 1
        };
    },

    storage(o) {
        const n = o.name;
        const type = /HDD|Жесткий/i.test(n) ? "HDD" : "SSD";
        const cap = n.match(/(\d{1,5})\s?(GB|TB|G)\b/i);
        const form = /\bmSATA\b/i.test(n) ? "mSATA" : /\b[MМ][.,]?2\b/i.test(n) ? "M.2" :/2[.,]5\s?"|2[.,]5''|2[.,]5″/i.test(n) ? "2.5″" : /3[.,]5/i.test(n) ? "3.5″" : null;
        const iface = /PCI-?e|NVMe/i.test(n) ? (first(n, /PCI-?e\s?(\d\.\d)/i) ? `NVMe PCIe ${first(n, /PCI-?e\s?(\d\.\d)/i)}` : "NVMe") : /SATA/i.test(n) ? "SATA" : null;
        return { type, capacity_gb: cap ? capacityGB(cap[1], cap[2]) : null, form_factor: form, interface: iface };
    },

    psu(o) {
        const n = o.name;
        const w = num(first(n, /(\d{3,4})\s?W\b/i)) ?? num(first(n, /(?:BPX|ZM|GM|SP|PK|YT|P)-?(\d{3,4})/i));
        return { wattage: w >= 200 && w <= 2500 ? w : null, form_factor: /SFX-?L/i.test(n) ? "SFX-L" : /SFX/i.test(n) ? "SFX" : "ATX" };
    },

    monitor(o) {
        const n = o.name;
        const d = num(first(n, /(\d{2}(?:[.,]\d)?)\s?(?:"|”|″|'')/));
        const text = `${n} ${o.description || ""}`;
        const hz = [...text.matchAll(/(\d{2,3})\s?(?:Hz|Гц)/gi)].map(m => num(m[1])).filter(v => v >= 50 && v <= 540);
        return { diagonal: d >= 15 && d <= 57 ? d : null, refresh_hz: hz.length ? Math.max(...hz) : null, color: color(n) };
    },

    keyboard(o) {
        const n = o.name;
        return {
            connection: connection(n),
            mechanical: /switch|cherry|mx |mechan|механ|gateron|kailh|outemu/i.test(n),
            gaming: /игров/i.test(o.params?.category || "") || /gaming|bloody|razer|hyperx|steelseries|glorious|varmilo/i.test(n),
            color: color(n)
        };
    },

    mouse(o) {
        const n = o.name;
        return {
            connection: connection(n),
            gaming: /игров/i.test(o.params?.category || "") || /gaming|bloody|razer|hyperx|steelseries|glorious|g\d{3}|viper|deathadder/i.test(n),
            color: color(n)
        };
    },

    headphones(o) {
        const n = o.name;
        return {
            connection: /bluetooth|беспровод|wireless|TWS/i.test(n) || /беспровод/i.test(o.params?.category || "") ? "Wireless" : "Wired",
            microphone: /гарнитура|headset|микрофон|mic/i.test(n),
            color: color(n)
        };
    },

    printer(o) {
        const text = `${o.params?.category || ""} ${o.name}`;
        return {
            device: /МФУ/i.test(text) ? "MFP" : "Printer",
            technology: /лазер/i.test(text) || /laser/i.test(o.name) ? "Laser" : /струй/i.test(text) || /ink|tank|pixma|ecotank|L\d{4}/i.test(o.name) ? "Inkjet" : /фото|photo/i.test(o.name) ? "Photo" : null
        };
    }
};

/** Feed sub-categories that belong to another category than the parent feed category says */
const SUBCATEGORY_OVERRIDES = [
    [/^клавиатур|игровые клавиатур/i, "keyboard"],
    [/^мыш|игровые мыш/i, "mouse"]
];

function parseSpecs(category, offer) {
    const parser = PARSERS[category];
    if (!parser) return {};
    const specs = parser(offer);
    for (const k of Object.keys(specs)) if (specs[k] === null || specs[k] === undefined) delete specs[k];
    return specs;
}

module.exports = { parseSpecs, SUBCATEGORY_OVERRIDES };
