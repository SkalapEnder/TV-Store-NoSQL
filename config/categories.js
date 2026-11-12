/**
 * Product categories of the store.
 *
 * A category is a property of the product (`product.category` = slug), not a collection: the list
 * is fixed in code because every category also defines the shape of `product.specs` (which fields
 * exist, their type and how the catalog filters them). The feed ids say which shop.kz categories
 * are imported into each of ours.
 *
 * Spec fields:
 *   key      field name in product.specs
 *   label    shown on the product page and in filters
 *   type     "number" | "enum" | "bool"
 *   unit     appended to numbers ("GB", "W", "″")
 *   filter   "range" (min/max inputs) | "select" (checkbox list with counts) | "bool" (switch) | none
 *   card     shown as a pill on the product card
 */

const GROUPS = [
    { slug: "phones-tv",   name: "Phones & TV",           icon: "bi-phone" },
    { slug: "pc-parts",    name: "PC components",         icon: "bi-cpu" },
    { slug: "peripherals", name: "Monitors & peripherals", icon: "bi-display" },
    { slug: "office",      name: "Office",                icon: "bi-printer" }
];

const CATEGORIES = [
    {
        slug: "phone", name: "Smartphones", single: "Smartphone", group: "phones-tv", icon: "bi-phone",
        description: "Android smartphones from Xiaomi, Samsung, HONOR, Tecno and more",
        feedIds: ["199"],
        specs: [
            { key: "storage_gb", label: "Storage", type: "number", unit: "GB", filter: "select", card: true },
            { key: "ram_gb",     label: "RAM",     type: "number", unit: "GB", filter: "select", card: true },
            { key: "color",      label: "Colour",  type: "enum" }
        ]
    },
    {
        slug: "tv", name: "Televisions", single: "TV", group: "phones-tv", icon: "bi-tv",
        description: "Smart TVs: OLED, QLED, Mini LED and LED screens for every room",
        feedIds: ["274"],
        specs: [
            { key: "diagonal", label: "Screen size", type: "number", unit: "″", filter: "range", card: true },
            { key: "panel",    label: "Panel",       type: "enum", filter: "select", card: true }
        ]
    },
    {
        slug: "gpu", name: "Graphics cards", single: "Graphics card", group: "pc-parts", icon: "bi-gpu-card",
        description: "GeForce and Radeon graphics cards for gaming and work",
        feedIds: ["197"],
        specs: [
            { key: "chip_vendor", label: "GPU maker",   type: "enum", filter: "select" },
            { key: "chip",        label: "GPU",         type: "enum", filter: "select", card: true },
            { key: "memory_gb",   label: "Video memory", type: "number", unit: "GB", filter: "select", card: true }
        ]
    },
    {
        slug: "cpu", name: "Processors", single: "Processor", group: "pc-parts", icon: "bi-cpu",
        description: "Intel Core and AMD Ryzen desktop processors",
        feedIds: ["214"],
        specs: [
            { key: "series",    label: "Series",          type: "enum", filter: "select", card: true },
            { key: "socket",    label: "Socket",          type: "enum", filter: "select", card: true },
            { key: "packaging", label: "Packaging",       type: "enum", filter: "select" },
            { key: "cooler",    label: "Cooler included", type: "bool", filter: "bool" }
        ]
    },
    {
        slug: "motherboard", name: "Motherboards", single: "Motherboard", group: "pc-parts", icon: "bi-motherboard",
        description: "Motherboards for Intel LGA1700/1851 and AMD AM4/AM5",
        feedIds: ["211"],
        specs: [
            { key: "socket",  label: "Socket",  type: "enum", filter: "select", card: true },
            { key: "chipset", label: "Chipset", type: "enum", filter: "select", card: true },
            { key: "memory",  label: "Memory type", type: "enum", filter: "select" },
            { key: "wifi",    label: "Wi-Fi",   type: "bool", filter: "bool" }
        ]
    },
    {
        slug: "ram", name: "Memory (RAM)", single: "Memory", group: "pc-parts", icon: "bi-memory",
        description: "DDR4 and DDR5 desktop memory modules and kits",
        feedIds: ["213"],
        specs: [
            { key: "type",        label: "Type",     type: "enum", filter: "select", card: true },
            { key: "capacity_gb", label: "Capacity", type: "number", unit: "GB", filter: "select", card: true },
            { key: "speed_mhz",   label: "Speed",    type: "number", unit: "MHz", filter: "range" },
            { key: "modules",     label: "Modules in kit", type: "number", filter: "select" }
        ]
    },
    {
        slug: "storage", name: "Storage", single: "Drive", group: "pc-parts", icon: "bi-device-ssd",
        description: "SSD and hard drives: NVMe, SATA, 2.5″ and 3.5″",
        feedIds: ["200", "13901"],
        specs: [
            { key: "type",        label: "Type",        type: "enum", filter: "select", card: true },
            { key: "capacity_gb", label: "Capacity",    type: "number", unit: "GB", filter: "range", card: true },
            { key: "form_factor", label: "Form factor", type: "enum", filter: "select" },
            { key: "interface",   label: "Interface",   type: "enum", filter: "select" }
        ]
    },
    {
        slug: "psu", name: "Power supplies", single: "Power supply", group: "pc-parts", icon: "bi-lightning-charge",
        description: "ATX and SFX power supplies from 400 to 1600 W",
        feedIds: ["208"],
        specs: [
            { key: "wattage",     label: "Power",       type: "number", unit: "W", filter: "range", card: true },
            { key: "form_factor", label: "Form factor", type: "enum", filter: "select", card: true }
        ]
    },
    {
        slug: "monitor", name: "Monitors", single: "Monitor", group: "peripherals", icon: "bi-display",
        description: "Office and gaming monitors from 21.5″ to 49″",
        feedIds: ["195"],
        specs: [
            { key: "diagonal",   label: "Screen size",  type: "number", unit: "″", filter: "range", card: true },
            { key: "refresh_hz", label: "Refresh rate", type: "number", unit: "Hz", filter: "select", card: true },
            { key: "color",      label: "Colour",       type: "enum" }
        ]
    },
    {
        slug: "keyboard", name: "Keyboards", single: "Keyboard", group: "peripherals", icon: "bi-keyboard",
        description: "Office, mechanical and gaming keyboards",
        feedIds: ["222"],
        specs: [
            { key: "connection", label: "Connection", type: "enum", filter: "select", card: true },
            { key: "mechanical", label: "Mechanical", type: "bool", filter: "bool", card: true },
            { key: "gaming",     label: "Gaming",     type: "bool", filter: "bool" },
            { key: "color",      label: "Colour",     type: "enum" }
        ]
    },
    {
        slug: "mouse", name: "Mice", single: "Mouse", group: "peripherals", icon: "bi-mouse",
        description: "Wired, wireless and gaming mice",
        feedIds: ["224"],
        specs: [
            { key: "connection", label: "Connection", type: "enum", filter: "select", card: true },
            { key: "gaming",     label: "Gaming",     type: "bool", filter: "bool", card: true },
            { key: "color",      label: "Colour",     type: "enum" }
        ]
    },
    {
        slug: "headphones", name: "Headphones", single: "Headphones", group: "peripherals", icon: "bi-headphones",
        description: "Wired and Bluetooth headphones and headsets",
        feedIds: ["235", "14371"],
        specs: [
            { key: "connection", label: "Connection", type: "enum", filter: "select", card: true },
            { key: "microphone", label: "Microphone", type: "bool", filter: "bool", card: true },
            { key: "color",      label: "Colour",     type: "enum" }
        ]
    },
    {
        slug: "printer", name: "Printers & MFPs", single: "Printer", group: "office", icon: "bi-printer",
        description: "Laser and inkjet printers and multifunction devices",
        feedIds: ["225", "226", "236", "237"],
        specs: [
            { key: "device",     label: "Device",     type: "enum", filter: "select", card: true },
            { key: "technology", label: "Technology", type: "enum", filter: "select", card: true }
        ]
    }
];

const BY_SLUG = new Map(CATEGORIES.map(c => [c.slug, c]));
const BY_FEED_ID = new Map(CATEGORIES.flatMap(c => c.feedIds.map(id => [id, c])));
const GROUP_BY_SLUG = new Map(GROUPS.map(g => [g.slug, g]));

const getCategory = slug => BY_SLUG.get(slug) || null;
const getGroup = slug => GROUP_BY_SLUG.get(slug) || null;
const categoriesOfGroup = group => CATEGORIES.filter(c => c.group === group);

/** Formats a spec value for display: 12 + "GB" -> "12 GB", true -> "Yes", 55 + "″" -> "55″" */
function formatSpec(spec, value) {
    if (value === undefined || value === null || value === "") return null;
    if (spec.type === "bool") return value ? "Yes" : "No";
    if (spec.type === "number") {
        if (spec.unit === "GB" && value >= 1000 && value % 1000 === 0) return `${value / 1000} TB`;
        const n = Number(value).toLocaleString("en-US");
        return spec.unit ? (spec.unit === "″" ? `${n}″` : `${n} ${spec.unit}`) : n;
    }
    return String(value);
}

/** Short pills for a product card, e.g. ["RTX 5070", "12 GB"] */
function cardSpecs(product) {
    const cat = getCategory(product.category);
    if (!cat || !product.specs) return [];
    return cat.specs
        .filter(s => s.card)
        .map(s => {
            const v = product.specs[s.key];
            if (s.type === "bool") return v ? s.label : null;
            return formatSpec(s, v);
        })
        .filter(Boolean)
        .slice(0, 2);
}

/**
 * Coerces raw values (form input, feed parser) into the types the category declares and drops
 * unknown keys. Used by the Product schema, the admin form and the importer.
 */
function cleanSpecs(slug, raw = {}) {
    const cat = getCategory(slug);
    if (!cat || !raw || typeof raw !== "object") return {};
    const out = {};
    for (const s of cat.specs) {
        let v = raw[s.key];
        if (v === undefined || v === null || v === "") continue;
        if (s.type === "number") {
            v = Number(String(v).replace(",", "."));
            if (!Number.isFinite(v) || v < 0) continue;
        } else if (s.type === "bool") {
            v = v === true || v === "true" || v === "on" || v === "1" || v === 1;
        } else {
            v = String(v).trim().slice(0, 60);
            if (!v) continue;
        }
        out[s.key] = v;
    }
    return out;
}

module.exports = {
    GROUPS, CATEGORIES,
    getCategory, getGroup, categoriesOfGroup, categoryForFeedId: id => BY_FEED_ID.get(String(id)) || null,
    formatSpec, cardSpecs, cleanSpecs
};
