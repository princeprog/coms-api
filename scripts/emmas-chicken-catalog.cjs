// Editable starter PHP prices and portion standards, not supplier quotations.
const branches = [
  { code: 'CEB', branch_name: 'Cebu', address: 'Cebu City, Cebu' },
  { code: 'MNL', branch_name: 'Manila', address: 'Manila, Metro Manila' },
  { code: 'DVO', branch_name: 'Davao', address: 'Davao City, Davao del Sur' },
];

// key, name, category, stock unit, daily physical count, usage.
const stock = [
  [
    'whole',
    'Raw Whole Chicken - Roasting Size',
    'Chicken and poultry',
    'pcs',
    true,
  ],
  [
    'cut',
    'Raw Chicken - Standard Frying Cut',
    'Chicken and poultry',
    'pcs',
    true,
  ],
  ['leg', 'Raw Chicken Leg Quarter', 'Chicken and poultry', 'pcs', true],
  ['fillet', 'Raw Boneless Chicken Fillet', 'Chicken and poultry', 'kg', true],
  ['skin', 'Raw Chicken Skin', 'Chicken and poultry', 'kg', true],
  ['rice', 'Well-Milled Rice - Uncooked', 'Rice and dry goods', 'kg', true],
  [
    'breading',
    'Seasoned Chicken Breading Mix',
    'Rice and dry goods',
    'kg',
    true,
  ],
  [
    'roast',
    'Roast Chicken Marinade - Ready to Use',
    'Marinades and sauces',
    'L',
    false,
  ],
  [
    'inasal',
    'Inasal Marinade - Ready to Use',
    'Marinades and sauces',
    'L',
    false,
  ],
  ['spice', 'Spicy Chicken Seasoning', 'Marinades and sauces', 'kg', false],
  ['oil', 'Frying Oil', 'Cooking essentials', 'L', false],
  ['chickenoil', 'Annatto Chicken Oil', 'Cooking essentials', 'L', false],
  ['gravy', 'Chicken Gravy - Prepared', 'Marinades and sauces', 'L', false],
  ['soy', 'Soy Sauce', 'Cooking essentials', 'L', false],
  ['vinegar', 'Cane Vinegar', 'Cooking essentials', 'L', false],
  ['salt', 'Iodized Salt', 'Cooking essentials', 'kg', false],
  ['pepper', 'Ground Black Pepper', 'Cooking essentials', 'kg', false],
  ['sugar', 'White Sugar', 'Cooking essentials', 'kg', false],
  ['garlic', 'Peeled Garlic', 'Vegetables and aromatics', 'kg', false],
  ['calamansi', 'Fresh Calamansi', 'Vegetables and aromatics', 'kg', false],
  ['fries', 'Frozen French Fries', 'Sides and accompaniments', 'kg', true],
  [
    'atchara',
    'Papaya Atchara - Prepared',
    'Sides and accompaniments',
    'kg',
    false,
  ],
  ['teamix', 'Lemon Iced Tea Powder', 'Beverage ingredients', 'kg', false],
  ['water', 'Purified Drinking Water', 'Beverage ingredients', 'L', false],
  ['ice', 'Food-Grade Tube Ice', 'Beverage ingredients', 'kg', false],
  [
    'bottled',
    'Bottled Water 500 mL',
    'Packaged beverages',
    'bottle',
    true,
    'READY_TO_SELL',
  ],
  ['cola', 'Cola 330 mL', 'Packaged beverages', 'can', true, 'READY_TO_SELL'],
  ['soda', 'Cola 1.5 L', 'Packaged beverages', 'bottle', true, 'READY_TO_SELL'],
  [
    'roastbag',
    'Roast Chicken Bag',
    'Food packaging',
    'pcs',
    false,
    'PACKAGING',
  ],
  ['mealbox', 'Chicken Meal Box', 'Food packaging', 'pcs', false, 'PACKAGING'],
  [
    'bucket6',
    'Chicken Bucket with Lid - 6 Pieces',
    'Food packaging',
    'pcs',
    false,
    'PACKAGING',
  ],
  [
    'bucket8',
    'Chicken Bucket with Lid - 8 Pieces',
    'Food packaging',
    'pcs',
    false,
    'PACKAGING',
  ],
  ['sidebox', 'Small Food Box', 'Food packaging', 'pcs', false, 'PACKAGING'],
  ['ricewrap', 'Rice Wrapper', 'Food packaging', 'pcs', false, 'PACKAGING'],
  [
    'gravycup',
    'Gravy Cup with Lid - 60 mL',
    'Food packaging',
    'pcs',
    false,
    'PACKAGING',
  ],
  [
    'drinkcup',
    'Cold Drink Cup with Lid and Straw - 16 oz',
    'Food packaging',
    'pcs',
    false,
    'PACKAGING',
  ],
  [
    'cutlery',
    'Disposable Spoon and Fork Set',
    'Food packaging',
    'set',
    false,
    'PACKAGING',
  ],
  [
    'dishwash',
    'Dishwashing Liquid',
    'Cleaning and sanitation',
    'L',
    false,
    'OPERATING_SUPPLY',
  ],
  [
    'sanitizer',
    'Food-Contact Surface Sanitizer',
    'Cleaning and sanitation',
    'L',
    false,
    'OPERATING_SUPPLY',
  ],
  [
    'gloves',
    'Disposable Food-Handling Gloves - 100 Pieces',
    'Cleaning and sanitation',
    'box',
    false,
    'OPERATING_SUPPLY',
  ],
].map(([key, name, category, unit, count, usage = 'INGREDIENT']) => ({
  key,
  stock_item_name: name,
  category,
  unit,
  daily_count_required: count,
  usage_types: [usage],
}));

const line = (key, quantity, scope = 'ALL') => ({
  key,
  quantity: String(quantity),
  scope,
});
const takeout = (key, quantity = '1') => line(key, quantity, 'TAKEAWAY');
const scale = (quantity, factor) => (Number(quantity) * factor).toFixed(4);
const roast = (birds, spicy = false) => [
  line('whole', birds),
  line('roast', scale('0.06', birds)),
  ...(spicy ? [line('spice', scale('0.008', birds))] : []),
];
const fried = (pieces, spicy = false) => [
  line('cut', pieces),
  line('breading', scale('0.025', pieces)),
  line('oil', scale('0.015', pieces)),
  ...(spicy ? [line('spice', scale('0.002', pieces))] : []),
];
const rice = (servings = 1) => line('rice', scale('0.065', servings));
const gravy = (servings = 1) => line('gravy', scale('0.05', servings));
const meal = (protein) => [
  ...protein,
  rice(),
  gravy(),
  takeout('mealbox'),
  takeout('gravycup'),
  takeout('cutlery'),
];
const chicken = 'Chicken',
  meals = 'Rice meals',
  sides = 'Sides',
  drinks = 'Beverages';
const products = [];
function add(key, product_name, category, price, description, recipe) {
  products.push({ key, product_name, category, price, description, recipe });
}

add(
  'whole-original',
  'Original Whole Roast Chicken',
  chicken,
  '389.00',
  'Whole Filipino-style roast chicken with a savory-sweet marinade.',
  [...roast(1), takeout('roastbag')],
);
add(
  'whole-spicy',
  'Spicy Whole Roast Chicken',
  chicken,
  '399.00',
  'Whole roast chicken with a spicy seasoning finish.',
  [...roast(1, true), takeout('roastbag')],
);
add(
  'half-roast',
  'Half Roast Chicken',
  chicken,
  '209.00',
  'Half of our original roast chicken, chopped for sharing.',
  [...roast(0.5), takeout('mealbox')],
);
add(
  'quarter-roast',
  'Quarter Roast Chicken',
  chicken,
  '115.00',
  'One quarter of our original roast chicken.',
  [...roast(0.25), takeout('sidebox')],
);
add(
  'fried-one',
  '1-Piece Crispy Fried Chicken',
  chicken,
  '85.00',
  'One crispy chicken piece with gravy.',
  [...fried(1), gravy(), takeout('sidebox'), takeout('gravycup')],
);
add(
  'fried-two',
  '2-Piece Crispy Fried Chicken',
  chicken,
  '159.00',
  'Two crispy chicken pieces with gravy.',
  [...fried(2), gravy(2), takeout('mealbox'), takeout('gravycup', '2')],
);
add(
  'bucket-six',
  '6-Piece Fried Chicken Bucket',
  chicken,
  '449.00',
  'Six crispy chicken pieces with three gravy servings.',
  [...fried(6), gravy(3), takeout('bucket6'), takeout('gravycup', '3')],
);
add(
  'bucket-eight',
  '8-Piece Fried Chicken Bucket',
  chicken,
  '589.00',
  'Eight crispy chicken pieces with four gravy servings.',
  [...fried(8), gravy(4), takeout('bucket8'), takeout('gravycup', '4')],
);
add(
  'bucket-spicy',
  '6-Piece Spicy Chicken Bucket',
  chicken,
  '469.00',
  'Six spicy crispy chicken pieces with three gravy servings.',
  [...fried(6, true), gravy(3), takeout('bucket6'), takeout('gravycup', '3')],
);
add(
  'meal-one',
  '1-Piece Fried Chicken Rice Meal',
  meals,
  '109.00',
  'One crispy chicken piece, steamed rice, and gravy.',
  meal(fried(1)),
);
add(
  'meal-two',
  '2-Piece Fried Chicken Rice Meal',
  meals,
  '179.00',
  'Two crispy chicken pieces, steamed rice, and gravy.',
  meal(fried(2)),
);
add(
  'meal-spicy',
  'Spicy Fried Chicken Rice Meal',
  meals,
  '119.00',
  'One spicy crispy chicken piece, steamed rice, and gravy.',
  meal(fried(1, true)),
);
add(
  'meal-roast',
  'Quarter Roast Chicken Rice Meal',
  meals,
  '139.00',
  'Quarter roast chicken, steamed rice, and gravy.',
  meal(roast(0.25)),
);
add(
  'meal-inasal',
  'Chicken Inasal Rice Meal',
  meals,
  '169.00',
  'Grilled chicken leg quarter, rice, chicken oil, and atchara.',
  [
    line('leg', '1'),
    line('inasal', '0.04'),
    rice(),
    line('chickenoil', '0.008'),
    line('atchara', '0.025'),
    takeout('mealbox'),
    takeout('cutlery'),
  ],
);
add(
  'meal-fillet',
  'Crispy Chicken Fillet Rice Meal',
  meals,
  '129.00',
  'Crispy boneless chicken fillet, steamed rice, and gravy.',
  meal([
    line('fillet', '0.15'),
    line('breading', '0.025'),
    line('oil', '0.015'),
  ]),
);
add(
  'roast-family',
  'Roast Chicken Family Meal',
  chicken,
  '519.00',
  'One original whole roast chicken, four rice servings, and one 1.5 L cola.',
  [
    ...roast(1),
    rice(4),
    line('soda', '1'),
    takeout('roastbag'),
    takeout('ricewrap', '4'),
    takeout('cutlery', '4'),
  ],
);
add(
  'fried-family',
  'Fried Chicken Family Meal',
  chicken,
  '599.00',
  'Six crispy chicken pieces, three rice servings, gravy, and one 1.5 L cola.',
  [
    ...fried(6),
    rice(3),
    gravy(3),
    line('soda', '1'),
    takeout('bucket6'),
    takeout('ricewrap', '3'),
    takeout('gravycup', '3'),
    takeout('cutlery', '3'),
  ],
);
add(
  'rice',
  'Steamed Rice',
  sides,
  '25.00',
  'One serving of freshly steamed rice.',
  [rice(), takeout('ricewrap')],
);
add(
  'garlic-rice',
  'Garlic Rice',
  sides,
  '35.00',
  'One serving of rice tossed with garlic and oil.',
  [rice(), line('garlic', '0.005'), line('oil', '0.005'), takeout('ricewrap')],
);
add('fries', 'French Fries', sides, '65.00', 'Golden fries, lightly salted.', [
  line('fries', '0.12'),
  line('oil', '0.01'),
  line('salt', '0.001'),
  takeout('sidebox'),
]);
add(
  'skin',
  'Crispy Chicken Skin',
  sides,
  '79.00',
  'Crispy chicken skin with spiced vinegar.',
  [
    line('skin', '0.10'),
    line('breading', '0.015'),
    line('oil', '0.01'),
    line('vinegar', '0.025'),
    line('pepper', '0.0005'),
    takeout('sidebox'),
    takeout('gravycup'),
  ],
);
add(
  'atchara',
  'Atchara Side',
  sides,
  '25.00',
  'A small serving of sweet and tangy pickled papaya.',
  [line('atchara', '0.05'), takeout('sidebox')],
);
add(
  'gravy',
  'Extra Gravy',
  sides,
  '15.00',
  'One extra 50 mL serving of chicken gravy.',
  [gravy(), takeout('gravycup')],
);
add(
  'bottled-water',
  'Bottled Water 500 mL',
  drinks,
  '25.00',
  'Sealed 500 mL bottled drinking water.',
  [line('bottled', '1')],
);
add('cola-can', 'Cola 330 mL', drinks, '45.00', 'Chilled 330 mL can of cola.', [
  line('cola', '1'),
]);
add(
  'cola-family',
  'Cola 1.5 L',
  drinks,
  '95.00',
  'A 1.5 L bottle of cola for sharing.',
  [line('soda', '1')],
);
add(
  'iced-tea',
  'Lemon Iced Tea - 16 oz',
  drinks,
  '39.00',
  'Chilled lemon iced tea over ice.',
  [
    line('teamix', '0.025'),
    line('water', '0.30'),
    line('ice', '0.15'),
    takeout('drinkcup'),
  ],
);
add(
  'calamansi',
  'Calamansi Cooler - 16 oz',
  drinks,
  '45.00',
  'Fresh calamansi juice, lightly sweetened and served over ice.',
  [
    line('calamansi', '0.05'),
    line('sugar', '0.02'),
    line('water', '0.25'),
    line('ice', '0.15'),
    takeout('drinkcup'),
  ],
);

module.exports = { branches, stock, products };
