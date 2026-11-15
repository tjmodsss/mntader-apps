# XtraBoost Guard (BMW G30 530e PHEV Stage 1)

Aplikacja dla BMW G30 530e (silnik B48 Stage 1 1.5 bar: 311 KM / 440 Nm + silnik elektryczny EME: 109 KM / 265 Nm = 420 KM mocy systemowej).

## Zakładki (Tabs)

### 1. XtraBoost Guard
- **Dual Power Split (60 FPS):** Równoczesny odczyt mocy i momentu silnika spalinowego B48 (skala do 340 KM / 500 Nm) oraz silnika elektrycznego EME (skala do 120 KM / 300 Nm).
- **Moc Systemowa & 60s Peak Hold (Hamownia):** Dynamiczna suma mocy w czasie rzeczywistym oraz zapamiętywanie szczytowych wartości mocy i momentu wraz z obrotami (np. 418 KM @ 5450 RPM | 582 Nm @ 3150 RPM) przez 60 sekund.
- **Detektor Dławienia BMS:** Automatyczne wykrywanie obcinania mocy elektrycznej przy niskim SoC (<25%) lub ograniczeniach prądowych pakietu baterii SME (`BMS LIMIT: -XX KM / -XXX Nm`).
- **Wskaźnik 100-200 READY:** Zielony status gotowości do pomiaru (olej 85–108°C, IAT < 45°C, 100% mocy elektryka) lub żółty/czerwony powód blokady.
- **Monitor Paliwa & Zapłonu (0x12 DME):** Doładowanie Boost w barach (cel 1.50 bar), temperatura w dolocie IAT, kąt zapłonu oraz korekty na cylindrach 1–4. Podświetlenie na czerwono przy korekcie poniżej progu -3.5° (wykrywanie słabej jakości PB95 / spalania stukowego). Przycisk dolnego paska `Reset Peak`.

### 2. Hamownia & Logi
- **Wykres Pulla (Virtual Dyno):** Równoczesne rysowanie krzywej mocy systemowej (zielona linia KM) oraz krzywej momentu obrotowego (niebieska linia Nm) w przedziale 1500–6800 RPM.
- **Oznaczenie Szczytów:** Wyraźne znaczniki na wykresie w punktach maksymalnej mocy oraz maksymalnego momentu z dokładnymi wartościami i obrotami.
- **Detektor Stukowego DME (-3.5°):** Słupki korekt zapłonu na poszczególnych obrotach z czerwoną linią graniczną -3.5° i natychmiastowym werdyktem bezpieczeństwa paliwa PB98 / dodatku Millers EcoMax.
- **Karta Wyników Hamowni:** Duże cyfry szczytowej mocy i momentu z podziałem na udział silnika spalinowego B48 i elektrycznego EME oraz maksymalnego doładowania i temperatury dolotu IAT. Przycisk `Resetuj Wykres / Dyno`.

### 3. Warmup & Turbo
- **Wskaźniki Temperatur:** Dokładna temperatura oleju silnikowego oraz płynu chłodniczego B48.
- **Hybrid Cold-Start Guard:** Dynamiczne pułapy obrotów i doładowania przy nagłym rozruchu silnika z jazdy EV:
  - Olej < 50°C: `TRYB ZIMNY` (limit 2500 RPM, max boost 0.0 bar + ostrzeżenie wizualne przy mocniejszym gazie).
  - Olej 50–79°C: `ROZGRZEWANIE` (płynny limit 2800–4200 RPM, max boost 0.6 bar).
  - Olej >= 80°C: `TEMPERATURA ROBOCZA` (odblokowane pełne 6500 RPM i 1.5 bar).
- **Strażnik Chłodzenia Turbiny:** Wykrywa obciążenie silnika (boost > 1.0 bar, wysokie RPM lub olej > 102°C) i odlicza 90 sekund z wyraźnym ostrzeżeniem przed wyłączeniem silnika przez hybrydowy Auto Start/Stop.

### 4. Service Tracker
- **Inteligentny Licznik B48 vs EV:** Śledzi przyrost kilometrów i rozdziela go w tle na `ice_km` (gdy RPM > 0) oraz `ev_km` (gdy RPM == 0).
- **Atomowy Zapis:** Dane w `data/service_state.json` odporne na restart jednostki MGU.
- **Wartości początkowe (Seed):**
  - Przebieg bazowy auta: 113 000 km
  - Olej silnikowy (Millers 5W-40): limit 10 500 km (start: 0 km B48)
  - Filtr powietrza: limit 21 000 km (start: 2 800 km B48)
  - Świece zapłonowe NGK: limit 35 000 km (start: 0 km B48)
- **Obsługa:** 3 paski zużycia, udział jazdy na prądzie (EV %) oraz kasowanie wybranego interwału z 5-sekundowym zabezpieczeniem podwójnego kliknięcia pokrętłem iDrive.
