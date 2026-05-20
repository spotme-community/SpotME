// wetter.js
function weatherIcon(code) {
  if (code === 0)           return { icon:'☀️',  label:'Klar' };
  if (code <= 2)            return { icon:'🌤️',  label:'Leicht bewölkt' };
  if (code === 3)           return { icon:'☁️',  label:'Bedeckt' };
  if (code <= 49)           return { icon:'🌫️',  label:'Nebel' };
  if (code <= 59)           return { icon:'🌦️',  label:'Nieselregen' };
  if (code <= 69)           return { icon:'🌧️',  label:'Regen' };
  if (code <= 79)           return { icon:'🌨️',  label:'Schnee' };
  if (code <= 84)           return { icon:'🌦️',  label:'Regenschauer' };
  if (code <= 94)           return { icon:'⛈️',  label:'Gewitter' };
  return                         { icon:'⛈️',  label:'Starkes Gewitter' };
}

export async function fetchWeatherAndBuildHTML(lat, lng) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code,wind_speed_10m&hourly=temperature_2m,weather_code,wind_speed_10m&timezone=auto&wind_speed_unit=kmh&forecast_hours=9`;
    const resp = await fetch(url);
    if (!resp.ok) return '';
    const data = await resp.json();
    const weather = data.current || null;
    if (!weather) return '';

    if (weather && data.hourly) weather._hourly = data.hourly;

    const { icon, label } = weatherIcon(weather.weather_code);
    const temp = Math.round(weather.temperature_2m);
    const wind = Math.round(weather.wind_speed_10m);

    let forecastHtml = '';
    if (weather._hourly) {
      const now      = new Date();
      const nowHour  = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours()).getTime();
      const times    = weather._hourly.time;
      const temps    = weather._hourly.temperature_2m;
      const codes    = weather._hourly.weather_code;

      const startIdx = times.findIndex(t => new Date(t).getTime() >= nowHour);
      if (startIdx !== -1) {
        const hours = times.slice(startIdx, startIdx + 8);
        forecastHtml = `
          <div style="margin-top:0.6rem;display:flex;gap:0.4rem;overflow-x:auto;padding-bottom:4px;">
            ${hours.map((t, i) => {
              const idx  = startIdx + i;
              const hr   = new Date(t).getHours();
              const wi   = weatherIcon(codes[idx]);
              const tmp  = Math.round(temps[idx]);
              const isNow = i === 0;
              return `<div style="
                flex-shrink:0;text-align:center;
                background:${isNow ? 'rgba(245,158,11,0.12)' : 'rgba(255,255,255,0.04)'};
                border:1px solid ${isNow ? 'rgba(245,158,11,0.3)' : 'var(--bord)'};
                border-radius:10px;padding:0.5rem 0.6rem;min-width:52px;
              ">
                <div style="font-size:0.65rem;color:${isNow ? 'var(--acc)' : 'var(--muted)'};font-family:'Space Mono',monospace;font-weight:${isNow ? '700' : '400'};">
                  ${isNow ? 'JETZT' : hr + ':00'}
                </div>
                <div style="font-size:1.2rem;margin:3px 0;">${wi.icon}</div>
                <div style="font-size:0.8rem;font-weight:600;">${tmp}°</div>
              </div>`;
            }).join('')}
          </div>`;
      }
    }

    return `
      <div style="
        background:var(--card); border:1px solid var(--bord);
        border-radius:12px; padding:0.75rem 1rem; margin-bottom:0.75rem;
      ">
        <div style="display:flex;align-items:center;gap:0.75rem;">
          <span style="font-size:1.8rem;line-height:1;">${icon}</span>
          <div style="flex:1;">
            <div style="font-family:'Space Mono',monospace;font-size:0.68rem;color:var(--muted);letter-spacing:.08em;margin-bottom:2px;">WETTER AM SPOT</div>
            <div style="font-weight:600;font-size:0.95rem;">${temp}°C · ${label}</div>
            <div style="font-size:0.72rem;color:var(--muted2);margin-top:1px;">💨 ${wind} km/h</div>
          </div>
        </div>
        ${forecastHtml}
      </div>`;
  } catch (err) {
    console.warn('Wetter-Fehler:', err);
    return '';
  }
}