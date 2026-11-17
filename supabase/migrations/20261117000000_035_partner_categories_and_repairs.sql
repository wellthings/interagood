-- 035: Replace partner_categories with 13 categories, add repairing_services column, and create partner_repairing_services table.

ALTER TABLE public.partner_categories
  ADD COLUMN IF NOT EXISTS repairing_services JSONB NOT NULL DEFAULT '[]'::jsonb;

DELETE FROM public.partner_categories;
SELECT setval(pg_get_serial_sequence('public.partner_categories', 'id'), 1, false);

INSERT INTO public.partner_categories (id, name, hindi_name, icon_name, is_active, repairing_services) VALUES
  (1, 'Carpenter (Woodwork & Furniture)', 'कारपेंटर (लकड़ी व फर्नीचर का काम)', 'hammer', TRUE, '["Door lock, handle, tower bolt & stopper installation/repair","Door alignment, hinges & hydraulic door closer fixing","Drawer channel, slider & wardrobe shutter adjustment","Modular kitchen soft-close hinge & basket channel repair","Wooden bed, sofa, chair & dining table joint/leg repair","Mosquito mesh (jali) door hinge & net replacement","Wall shelf, TV bracket & curtain rod installation"]'::jsonb),
  (2, 'Electrician (Electrical & Lighting)', 'इलेक्ट्रीशियन (इलेक्ट्रिकल व लाइटिंग)', 'zap', TRUE, '["Switch, socket, dimmer & fan regulator replacement","Ceiling fan, wall fan & exhaust fan installation/repair","Tube light, LED panel, COB light & chandelier fitting","MCB, fuse & main distribution box trip/short-circuit repair","Inverter & battery wiring connection/check","Doorbell, smart lock power & CCTV camera installation","Geyser, AC & heavy appliance power point repair"]'::jsonb),
  (3, 'Plumber (Sanitary & Water Fitting)', 'प्लम्बर (सैनिटरी व वाटर फिटिंग)', 'droplet', TRUE, '["Leaking tap, wall mixer, diverter & valve repair/replacement","Washbasin, kitchen sink & bathroom drain blockage clearing","Toilet flush tank, jet spray (health faucet) & seat cover repair","Overhead water tank float valve, ball cock & overflow fixing","Shower head, soap dish & towel rod installation","Washing machine, dishwasher & RO inlet/outlet pipe fitting","Angle cock & flexible connection pipe replacement"]'::jsonb),
  (4, 'Painter & Polisher (Paint, Putty & Polish)', 'पेंटर व पॉलिशर (पेंट, पुट्टी व पॉलिश)', 'paint-brush', TRUE, '["Wall dampness (seelan) & crack putty touch-up","Single wall or single room repainting","Peeling, bubbling & flaking paint repair","Main door & wooden furniture polish/varnish touch-up","Iron gate & window grill enamel paint touch-up"]'::jsonb),
  (5, 'False Ceiling & POP', 'फॉल्स सीलिंग व पीओपी', 'layers', TRUE, '["Cracked, sagging or water-damaged POP/gypsum patch repair","Ceiling light / fan cutout modification & resizing","POP cornice & wall molding repair","Loose ceiling grid/channel tightening"]'::jsonb),
  (6, 'Tile, Marble & Granite Work', 'टाइल, मार्बल व ग्रेनाइट का काम', 'grid', TRUE, '["Broken, cracked or hollow floor/wall tile replacement","Tile grouting, gap filling & white cement/epoxy work","Bathroom floor slope & water logging correction","Loose skirting tile re-fixing","Kitchen granite countertop crack filling & edge polishing","Kitchen sink / gas hob cutout modification"]'::jsonb),
  (7, 'Wooden Flooring', 'वुडन फ्लोरिंग', 'layout-grid', TRUE, '["Scratched, swollen or damaged wooden plank replacement","Loose or squeaking floor plank locking/fixing","Wooden floor skirting & transition strip (T-molding) repair","Laminate/engineered wood gap filling & polishing"]'::jsonb),
  (8, 'Aluminium & UPVC Work (Doors & Windows)', 'एल्युमिनियम व यूपीवीसी वर्क (दरवाजे व खिड़कियां)', 'maximize', TRUE, '["Sliding window roller / wheel replacement","Aluminium/UPVC door lock, handle & multi-point latch repair","Window rubber gasket & wool pile replacement (sound/dust seal)","Sliding track cleaning, straightening & alignment","Mosquito mesh (jali) sliding shutter repair"]'::jsonb),
  (9, 'Glass & Mirror Work', 'ग्लास व मिरर वर्क', 'square', TRUE, '["Broken window, door or partition glass replacement","Bathroom LED / normal mirror installation","Glass shelf & dining table top fitting","Toughened glass door hydraulic floor spring & patch fitting repair","Frosted / privacy & decorative glass film pasting"]'::jsonb),
  (10, 'Iron & Steel Fabrication (Welding, Gate & Grill)', 'आयरन व स्टील फैब्रिकेशन (वेल्डिंग, गेट व ग्रिल)', 'flame', TRUE, '["Main gate hinge, wheel, latch & lock welding repair","Window safety grill & balcony railing joint welding","Stainless steel (SS) stair railing tightening & buffing","Tin / polycarbonate shade sheet patch & screw fixing"]'::jsonb),
  (11, 'Sofa, Curtain & Upholstery', 'सोफा, कर्टेन व अपहोल्स्ट्री', 'home', TRUE, '["Sofa cushion foam sagging & spring refilling","Torn sofa fabric / leatherette patch or cover replacement","Dining chair & office chair seat re-cushioning","Curtain rod, channel track & bracket installation","Roller / zebra blinds cord & mechanism repair"]'::jsonb),
  (12, 'Wallpaper & Wall Paneling', 'वॉलपेपर व वॉल पैनलिंग', 'palette', TRUE, '["Peeling wallpaper corner/joint pasting & patch repair","Single accent wall wallpaper installation","Damaged or loose PVC / WPC louver wall panel replacement","Decorative wall molding / beading re-fixing"]'::jsonb),
  (13, 'AC & Appliances Installation/Repair', 'एसी व अप्लायंसेस इंस्टॉलेशन/रिपेयर', 'wind', TRUE, '["Split & window AC installation / uninstallation","AC jet-pump foam service, filter cleaning & water leakage fix","AC gas refilling & copper pipe leakage repair","Geyser (water heater) installation, thermostat & coil repair","Kitchen chimney installation, duct pipe & filter service","RO water purifier installation & filter change"]'::jsonb);

SELECT setval(pg_get_serial_sequence('public.partner_categories', 'id'), (SELECT COALESCE(MAX(id), 1) FROM public.partner_categories));

-- Refresh compatibility view if it exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'partner_category') THEN
    CREATE OR REPLACE VIEW public.partner_category AS SELECT * FROM public.partner_categories;
  END IF;
END $$;

-- Normalized child table storing every category's repairing & fixing services
DROP TABLE IF EXISTS public.partner_repairing_services CASCADE;
CREATE TABLE public.partner_repairing_services (
  id SERIAL PRIMARY KEY,
  category_id INT NOT NULL REFERENCES public.partner_categories(id) ON DELETE CASCADE,
  category_name VARCHAR(120) NOT NULL,
  repairing_service TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (category_id, repairing_service)
);

CREATE INDEX IF NOT EXISTS idx_partner_repairing_services_cat ON public.partner_repairing_services(category_id, sort_order);

ALTER TABLE public.partner_repairing_services ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role manages partner_repairing_services" ON public.partner_repairing_services;
CREATE POLICY "Service role manages partner_repairing_services"
  ON public.partner_repairing_services
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

INSERT INTO public.partner_repairing_services (category_id, category_name, repairing_service, sort_order, is_active) VALUES
  (1, 'Carpenter (Woodwork & Furniture)', 'Door lock, handle, tower bolt & stopper installation/repair', 1, TRUE),
  (1, 'Carpenter (Woodwork & Furniture)', 'Door alignment, hinges & hydraulic door closer fixing', 2, TRUE),
  (1, 'Carpenter (Woodwork & Furniture)', 'Drawer channel, slider & wardrobe shutter adjustment', 3, TRUE),
  (1, 'Carpenter (Woodwork & Furniture)', 'Modular kitchen soft-close hinge & basket channel repair', 4, TRUE),
  (1, 'Carpenter (Woodwork & Furniture)', 'Wooden bed, sofa, chair & dining table joint/leg repair', 5, TRUE),
  (1, 'Carpenter (Woodwork & Furniture)', 'Mosquito mesh (jali) door hinge & net replacement', 6, TRUE),
  (1, 'Carpenter (Woodwork & Furniture)', 'Wall shelf, TV bracket & curtain rod installation', 7, TRUE),
  (2, 'Electrician (Electrical & Lighting)', 'Switch, socket, dimmer & fan regulator replacement', 1, TRUE),
  (2, 'Electrician (Electrical & Lighting)', 'Ceiling fan, wall fan & exhaust fan installation/repair', 2, TRUE),
  (2, 'Electrician (Electrical & Lighting)', 'Tube light, LED panel, COB light & chandelier fitting', 3, TRUE),
  (2, 'Electrician (Electrical & Lighting)', 'MCB, fuse & main distribution box trip/short-circuit repair', 4, TRUE),
  (2, 'Electrician (Electrical & Lighting)', 'Inverter & battery wiring connection/check', 5, TRUE),
  (2, 'Electrician (Electrical & Lighting)', 'Doorbell, smart lock power & CCTV camera installation', 6, TRUE),
  (2, 'Electrician (Electrical & Lighting)', 'Geyser, AC & heavy appliance power point repair', 7, TRUE),
  (3, 'Plumber (Sanitary & Water Fitting)', 'Leaking tap, wall mixer, diverter & valve repair/replacement', 1, TRUE),
  (3, 'Plumber (Sanitary & Water Fitting)', 'Washbasin, kitchen sink & bathroom drain blockage clearing', 2, TRUE),
  (3, 'Plumber (Sanitary & Water Fitting)', 'Toilet flush tank, jet spray (health faucet) & seat cover repair', 3, TRUE),
  (3, 'Plumber (Sanitary & Water Fitting)', 'Overhead water tank float valve, ball cock & overflow fixing', 4, TRUE),
  (3, 'Plumber (Sanitary & Water Fitting)', 'Shower head, soap dish & towel rod installation', 5, TRUE),
  (3, 'Plumber (Sanitary & Water Fitting)', 'Washing machine, dishwasher & RO inlet/outlet pipe fitting', 6, TRUE),
  (3, 'Plumber (Sanitary & Water Fitting)', 'Angle cock & flexible connection pipe replacement', 7, TRUE),
  (4, 'Painter & Polisher (Paint, Putty & Polish)', 'Wall dampness (seelan) & crack putty touch-up', 1, TRUE),
  (4, 'Painter & Polisher (Paint, Putty & Polish)', 'Single wall or single room repainting', 2, TRUE),
  (4, 'Painter & Polisher (Paint, Putty & Polish)', 'Peeling, bubbling & flaking paint repair', 3, TRUE),
  (4, 'Painter & Polisher (Paint, Putty & Polish)', 'Main door & wooden furniture polish/varnish touch-up', 4, TRUE),
  (4, 'Painter & Polisher (Paint, Putty & Polish)', 'Iron gate & window grill enamel paint touch-up', 5, TRUE),
  (5, 'False Ceiling & POP', 'Cracked, sagging or water-damaged POP/gypsum patch repair', 1, TRUE),
  (5, 'False Ceiling & POP', 'Ceiling light / fan cutout modification & resizing', 2, TRUE),
  (5, 'False Ceiling & POP', 'POP cornice & wall molding repair', 3, TRUE),
  (5, 'False Ceiling & POP', 'Loose ceiling grid/channel tightening', 4, TRUE),
  (6, 'Tile, Marble & Granite Work', 'Broken, cracked or hollow floor/wall tile replacement', 1, TRUE),
  (6, 'Tile, Marble & Granite Work', 'Tile grouting, gap filling & white cement/epoxy work', 2, TRUE),
  (6, 'Tile, Marble & Granite Work', 'Bathroom floor slope & water logging correction', 3, TRUE),
  (6, 'Tile, Marble & Granite Work', 'Loose skirting tile re-fixing', 4, TRUE),
  (6, 'Tile, Marble & Granite Work', 'Kitchen granite countertop crack filling & edge polishing', 5, TRUE),
  (6, 'Tile, Marble & Granite Work', 'Kitchen sink / gas hob cutout modification', 6, TRUE),
  (7, 'Wooden Flooring', 'Scratched, swollen or damaged wooden plank replacement', 1, TRUE),
  (7, 'Wooden Flooring', 'Loose or squeaking floor plank locking/fixing', 2, TRUE),
  (7, 'Wooden Flooring', 'Wooden floor skirting & transition strip (T-molding) repair', 3, TRUE),
  (7, 'Wooden Flooring', 'Laminate/engineered wood gap filling & polishing', 4, TRUE),
  (8, 'Aluminium & UPVC Work (Doors & Windows)', 'Sliding window roller / wheel replacement', 1, TRUE),
  (8, 'Aluminium & UPVC Work (Doors & Windows)', 'Aluminium/UPVC door lock, handle & multi-point latch repair', 2, TRUE),
  (8, 'Aluminium & UPVC Work (Doors & Windows)', 'Window rubber gasket & wool pile replacement (sound/dust seal)', 3, TRUE),
  (8, 'Aluminium & UPVC Work (Doors & Windows)', 'Sliding track cleaning, straightening & alignment', 4, TRUE),
  (8, 'Aluminium & UPVC Work (Doors & Windows)', 'Mosquito mesh (jali) sliding shutter repair', 5, TRUE),
  (9, 'Glass & Mirror Work', 'Broken window, door or partition glass replacement', 1, TRUE),
  (9, 'Glass & Mirror Work', 'Bathroom LED / normal mirror installation', 2, TRUE),
  (9, 'Glass & Mirror Work', 'Glass shelf & dining table top fitting', 3, TRUE),
  (9, 'Glass & Mirror Work', 'Toughened glass door hydraulic floor spring & patch fitting repair', 4, TRUE),
  (9, 'Glass & Mirror Work', 'Frosted / privacy & decorative glass film pasting', 5, TRUE),
  (10, 'Iron & Steel Fabrication (Welding, Gate & Grill)', 'Main gate hinge, wheel, latch & lock welding repair', 1, TRUE),
  (10, 'Iron & Steel Fabrication (Welding, Gate & Grill)', 'Window safety grill & balcony railing joint welding', 2, TRUE),
  (10, 'Iron & Steel Fabrication (Welding, Gate & Grill)', 'Stainless steel (SS) stair railing tightening & buffing', 3, TRUE),
  (10, 'Iron & Steel Fabrication (Welding, Gate & Grill)', 'Tin / polycarbonate shade sheet patch & screw fixing', 4, TRUE),
  (11, 'Sofa, Curtain & Upholstery', 'Sofa cushion foam sagging & spring refilling', 1, TRUE),
  (11, 'Sofa, Curtain & Upholstery', 'Torn sofa fabric / leatherette patch or cover replacement', 2, TRUE),
  (11, 'Sofa, Curtain & Upholstery', 'Dining chair & office chair seat re-cushioning', 3, TRUE),
  (11, 'Sofa, Curtain & Upholstery', 'Curtain rod, channel track & bracket installation', 4, TRUE),
  (11, 'Sofa, Curtain & Upholstery', 'Roller / zebra blinds cord & mechanism repair', 5, TRUE),
  (12, 'Wallpaper & Wall Paneling', 'Peeling wallpaper corner/joint pasting & patch repair', 1, TRUE),
  (12, 'Wallpaper & Wall Paneling', 'Single accent wall wallpaper installation', 2, TRUE),
  (12, 'Wallpaper & Wall Paneling', 'Damaged or loose PVC / WPC louver wall panel replacement', 3, TRUE),
  (12, 'Wallpaper & Wall Paneling', 'Decorative wall molding / beading re-fixing', 4, TRUE),
  (13, 'AC & Appliances Installation/Repair', 'Split & window AC installation / uninstallation', 1, TRUE),
  (13, 'AC & Appliances Installation/Repair', 'AC jet-pump foam service, filter cleaning & water leakage fix', 2, TRUE),
  (13, 'AC & Appliances Installation/Repair', 'AC gas refilling & copper pipe leakage repair', 3, TRUE),
  (13, 'AC & Appliances Installation/Repair', 'Geyser (water heater) installation, thermostat & coil repair', 4, TRUE),
  (13, 'AC & Appliances Installation/Repair', 'Kitchen chimney installation, duct pipe & filter service', 5, TRUE),
  (13, 'AC & Appliances Installation/Repair', 'RO water purifier installation & filter change', 6, TRUE);

-- Keep existing partner profiles aligned to the new category IDs by name
UPDATE public.profiles p SET category_id = 1, category_name = 'Carpenter (Woodwork & Furniture)' WHERE p.category_id IS NOT NULL AND lower(COALESCE(p.category_name, '')) LIKE '%carpenter%';
UPDATE public.profiles p SET category_id = 2, category_name = 'Electrician (Electrical & Lighting)' WHERE p.category_id IS NOT NULL AND lower(COALESCE(p.category_name, '')) LIKE '%electric%';
UPDATE public.profiles p SET category_id = 3, category_name = 'Plumber (Sanitary & Water Fitting)' WHERE p.category_id IS NOT NULL AND lower(COALESCE(p.category_name, '')) LIKE '%plumb%';
UPDATE public.profiles p SET category_id = 4, category_name = 'Painter & Polisher (Paint, Putty & Polish)' WHERE p.category_id IS NOT NULL AND lower(COALESCE(p.category_name, '')) LIKE '%paint%';
UPDATE public.profiles p SET category_id = 5, category_name = 'False Ceiling & POP' WHERE p.category_id IS NOT NULL AND (lower(COALESCE(p.category_name, '')) LIKE '%ceiling%' OR lower(COALESCE(p.category_name, '')) LIKE '%pop%');
UPDATE public.profiles p SET category_id = 6, category_name = 'Tile, Marble & Granite Work' WHERE p.category_id IS NOT NULL AND lower(COALESCE(p.category_name, '')) LIKE '%tile%';
UPDATE public.profiles p SET category_id = 8, category_name = 'Aluminium & UPVC Work (Doors & Windows)' WHERE p.category_id IS NOT NULL AND (lower(COALESCE(p.category_name, '')) LIKE '%alumin%' OR lower(COALESCE(p.category_name, '')) LIKE '%upvc%');
UPDATE public.profiles p SET category_id = 9, category_name = 'Glass & Mirror Work' WHERE p.category_id IS NOT NULL AND lower(COALESCE(p.category_name, '')) LIKE '%glass%';
UPDATE public.profiles p SET category_id = 10, category_name = 'Iron & Steel Fabrication (Welding, Gate & Grill)' WHERE p.category_id IS NOT NULL AND (lower(COALESCE(p.category_name, '')) LIKE '%weld%' OR lower(COALESCE(p.category_name, '')) LIKE '%fabricat%');

UPDATE public.profiles p SET category_id = 7, category_name = 'Wooden Flooring' WHERE p.category_id IS NOT NULL AND (lower(COALESCE(p.category_name, '')) LIKE '%wood%floor%' OR lower(COALESCE(p.category_name, '')) LIKE '%flooring%');
UPDATE public.profiles p SET category_id = 11, category_name = 'Sofa, Curtain & Upholstery' WHERE p.category_id IS NOT NULL AND (lower(COALESCE(p.category_name, '')) LIKE '%sofa%' OR lower(COALESCE(p.category_name, '')) LIKE '%curtain%' OR lower(COALESCE(p.category_name, '')) LIKE '%upholster%');
UPDATE public.profiles p SET category_id = 12, category_name = 'Wallpaper & Wall Paneling' WHERE p.category_id IS NOT NULL AND (lower(COALESCE(p.category_name, '')) LIKE '%wallpaper%' OR lower(COALESCE(p.category_name, '')) LIKE '%panel%');
UPDATE public.profiles p SET category_id = 13, category_name = 'AC & Appliances Installation/Repair' WHERE p.category_id IS NOT NULL AND (lower(COALESCE(p.category_name, '')) LIKE '%ac %' OR lower(COALESCE(p.category_name, '')) LIKE '%appliance%' OR lower(COALESCE(p.category_name, '')) LIKE '%geyser%');
