/**
 * Synthetic review texts for demo shoppers. A review is assembled from short phrases that match
 * the product's category, its specs and the star rating (5–4 positive, 3 mixed, 2–1 negative),
 * so the reviews on a product page read plausibly and agree with the stars.
 */

const pick = (rand, list) => list[Math.floor(rand() * list.length)];

const OPENING = {
    5: ["Excellent purchase.", "Very happy with it.", "Exactly what I was looking for.", "Five stars, no regrets.", "Great value for the money."],
    4: ["Good product overall.", "Happy with the purchase.", "Does the job well.", "Solid choice for the price.", "Pleasantly surprised."],
    3: ["It's okay.", "Mixed feelings.", "Average, nothing special.", "Decent, but not perfect.", "Works, with some compromises."],
    2: ["Somewhat disappointed.", "Expected more.", "Not great for the price.", "Has a few annoying problems."],
    1: ["Would not buy again.", "Very disappointed.", "Not worth the money.", "Returned it after a week."]
};

// Category phrases: [positive, mixed, negative]; {spec} placeholders are filled from product.specs
const PHRASES = {
    phone: [
        ["Battery easily lasts a full day.", "The screen is bright and smooth.", "{storage_gb} GB of storage is plenty for photos and apps.", "Camera is great in daylight.", "Fast and responsive, no lag."],
        ["Camera is fine in daylight but weak at night.", "Battery is average, charge it every evening.", "Some preinstalled apps I had to remove."],
        ["Gets warm and slows down in games.", "Battery drains too fast.", "The camera is noticeably worse than advertised."]
    ],
    tv: [
        ["Picture quality is excellent, colours are rich.", "The {diagonal}″ screen is the perfect size for our living room.", "Smart TV apps run smoothly.", "Setup took ten minutes."],
        ["Good picture, but the sound needs a soundbar.", "Smart menu is a bit slow sometimes.", "Viewing angles could be better."],
        ["Remote stopped working after a month.", "Noticeable backlight bleeding in dark scenes.", "The interface is slow and laggy."]
    ],
    gpu: [
        ["Runs modern games at high settings without problems.", "{memory_gb} GB of video memory is enough for 1440p.", "Quiet even under full load.", "Temperatures stay low."],
        ["Performance is good, but the fans get loud.", "Coil whine in some games.", "It is big, check your case size."],
        ["Runs hot and throttles.", "Driver crashes in several games.", "Too noisy under load."]
    ],
    cpu: [
        ["Fast in games and in work.", "Runs cool with a decent tower cooler.", "A big upgrade over my old processor.", "Great multitasking performance."],
        ["Fast, but needs a good cooler.", "Fine for gaming, a bit hot in rendering."],
        ["Runs very hot even at idle.", "Unstable until I updated the BIOS."]
    ],
    motherboard: [
        ["BIOS is clear and easy to use.", "Everything worked on the first boot.", "Good VRM, the CPU stays stable.", "Plenty of USB ports and M.2 slots."],
        ["Works fine, but the BIOS needed an update.", "Layout is a bit cramped."],
        ["Had to RMA it, did not post.", "Wi-Fi drops regularly."]
    ],
    ram: [
        ["XMP profile worked right away.", "{capacity_gb} GB is more than enough for gaming.", "Stable at rated speed.", "Looks nice in the case."],
        ["Works, but only after a BIOS update.", "Not stable at full speed on my board."],
        ["One stick failed after a week.", "Constant blue screens with XMP on."]
    ],
    storage: [
        ["Very fast, the system boots in seconds.", "Installed in five minutes.", "Plenty of space for my game library.", "Runs cool and silent."],
        ["Fast at first, slower on big copies.", "Gets warm without a heatsink."],
        ["Speeds are far below what is advertised.", "Disappeared from the system after a month."]
    ],
    psu: [
        ["Quiet and stable even under load.", "{wattage} W is plenty for my build.", "Cables are long and flexible.", "Feels well built."],
        ["Works, but the fan is audible.", "Cables are a bit stiff."],
        ["Makes a clicking noise.", "Shut down under full load."]
    ],
    monitor: [
        ["Colours look great out of the box.", "{refresh_hz} Hz feels very smooth in games.", "The {diagonal}″ size is perfect for my desk.", "Thin bezels, looks great."],
        ["Good picture, but the stand wobbles.", "Some backlight bleed in the corners."],
        ["Dead pixel right in the middle.", "Flickers at high refresh rate."]
    ],
    keyboard: [
        ["Typing feels great.", "Keys are responsive and well spaced.", "Backlight looks nice.", "Solid build, does not flex."],
        ["Comfortable, but a bit loud.", "Software is clunky."],
        ["Keys started double typing.", "Some keys stopped working after a month."]
    ],
    mouse: [
        ["Comfortable shape, fits my hand perfectly.", "Sensor is precise.", "Light and fast.", "Clicks feel crisp."],
        ["Okay, but the scroll wheel is loose.", "A bit small for large hands."],
        ["Double clicking after a few weeks.", "The cable is stiff and drags."]
    ],
    headphones: [
        ["Sound is clear with good bass.", "Comfortable even after hours.", "The microphone sounds clear in calls.", "Great noise isolation."],
        ["Good sound, but tight on the head.", "Microphone is average."],
        ["Left side stopped working.", "Uncomfortable after an hour."]
    ],
    printer: [
        ["Prints fast and quietly.", "Easy Wi-Fi setup.", "Print quality is sharp.", "Cheap to run."],
        ["Prints well, but the setup was confusing.", "Cartridges run out quickly."],
        ["Paper jams all the time.", "Driver installation is a nightmare."]
    ]
};

const CLOSING = {
    pos: ["Recommend.", "Would buy again.", "Delivery was fast too.", ""],
    mid: ["Okay for the price.", "Might look for something else next time.", ""],
    neg: ["Look elsewhere.", "Support was not helpful.", ""]
};

function fill(text, specs = {}) {
    return text.replace(/\{(\w+)\}/g, (_, key) => (specs[key] !== undefined && specs[key] !== null ? specs[key] : "the"))
        .replace(/\bthe ?(GB|W|Hz|″)/g, "the");
}

/** product: { category, specs }, rating 1..5, rand: () => [0,1) -> review text */
function makeReview(product, rating, rand) {
    const tone = rating >= 4 ? 0 : rating === 3 ? 1 : 2;
    const bank = PHRASES[product.category] || PHRASES.keyboard;
    const phrases = bank[tone].filter(p => !/\{(\w+)\}/.test(p) || [...p.matchAll(/\{(\w+)\}/g)].every(m => product.specs?.[m[1]] != null));
    const first = pick(rand, phrases);
    const parts = [pick(rand, OPENING[rating]), fill(first, product.specs)];
    if (rand() < 0.5) {
        const second = pick(rand, phrases.filter(p => p !== first));
        if (second) parts.push(fill(second, product.specs));
    }
    // Mixed reviews mention something good too
    if (tone === 1 && rand() < 0.6) parts.push(pick(rand, bank[0].filter(p => !p.includes("{"))));
    parts.push(pick(rand, CLOSING[tone === 0 ? "pos" : tone === 1 ? "mid" : "neg"]));
    return parts.filter(Boolean).join(" ");
}

/** Star rating of a purchased product when the shopper did not rate it: mostly positive */
function purchaseRating(rand) {
    const r = rand();
    return r < 0.45 ? 5 : r < 0.78 ? 4 : r < 0.9 ? 3 : r < 0.96 ? 2 : 1;
}

module.exports = { makeReview, purchaseRating };
