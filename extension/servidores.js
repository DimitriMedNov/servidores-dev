// Busca los servidores de desarrollo prendidos (vite, next, astro, python -m http.server…).
// Solo usa GLib y Gio, así se puede probar con gjs fuera de GNOME Shell.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const decodificador = new TextDecoder();
const HOME = GLib.get_home_dir();
const TICKS_POR_SEGUNDO = 100; // CLK_TCK de Linux en x86 y ARM

// Programas que corren servidores de desarrollo. Spotify, Claude Code, adb, etc. no entran.
const EJECUTABLES = /^(node|nodejs|bun|deno|python[\d.]*|ruby|php[\d.]*|java|dotnet)$/;

// Herramienta que se reconoce en la línea de comandos → nombre que se muestra.
const HERRAMIENTAS = [
    [/\bvite\b/, 'Vite'],
    [/next-server|\bnext\b/, 'Next.js'],
    [/\bnuxt\b/, 'Nuxt'],
    [/\bastro\b/, 'Astro'],
    [/svelte-kit/, 'SvelteKit'],
    [/\bremix\b/, 'Remix'],
    [/storybook/, 'Storybook'],
    [/webpack/, 'Webpack'],
    [/react-scripts/, 'Create React App'],
    [/\bexpo\b/, 'Expo'],
    [/\bparcel\b/, 'Parcel'],
    [/http\.server/, 'Python http.server'],
    [/uvicorn/, 'Uvicorn'],
    [/gunicorn/, 'Gunicorn'],
    [/flask/, 'Flask'],
    [/manage\.py/, 'Django'],
    [/\brails\b|puma/, 'Rails'],
    [/\bserve\b/, 'serve'],
];

// Archivos que marcan la raíz de un proyecto.
const RAICES = ['package.json', 'deno.json', 'pyproject.toml', 'manage.py', 'Gemfile', 'composer.json', '.git'];

function leer(ruta) {
    try {
        return decodificador.decode(GLib.file_get_contents(ruta)[1]);
    } catch {
        return null; // el proceso ya terminó o no es nuestro
    }
}

function enlace(ruta) {
    try {
        return GLib.file_read_link(ruta);
    } catch {
        return null;
    }
}

/** Campos de /proc/<pid>/stat después del nombre (que puede tener espacios y paréntesis). */
function camposStat(pid) {
    const stat = leer(`/proc/${pid}/stat`);
    return stat ? stat.slice(stat.lastIndexOf(')') + 2).split(' ') : null;
}

/** Momento de arranque del proceso, en ticks desde que prendió la computadora. Sirve de "huella" del pid. */
export function arranqueDe(pid) {
    const campos = camposStat(pid);
    return campos ? Number(campos[19]) : null;
}

function segundosPrendido(arranque) {
    const uptime = parseFloat(leer('/proc/uptime') ?? '0');
    return Math.max(0, uptime - arranque / TICKS_POR_SEGUNDO);
}

/** Memoria en uso (RAM + swap) del proceso y de todos sus hijos, en bytes. */
function memoriaDe(pid, vistos = new Set()) {
    if (vistos.has(pid))
        return 0;
    vistos.add(pid);
    let total = 0;
    const status = leer(`/proc/${pid}/status`) ?? '';
    for (const clave of ['VmRSS', 'VmSwap']) {
        const m = status.match(new RegExp(`^${clave}:\\s+(\\d+) kB`, 'm'));
        if (m)
            total += Number(m[1]) * 1024;
    }
    for (const hijo of (leer(`/proc/${pid}/task/${pid}/children`) ?? '').trim().split(/\s+/)) {
        if (hijo)
            total += memoriaDe(Number(hijo), vistos);
    }
    return total;
}

function herramientaDe(comando) {
    for (const [patron, nombre] of HERRAMIENTAS) {
        if (patron.test(comando))
            return nombre;
    }
    return null;
}

/** Sube desde la carpeta del proceso hasta encontrar la raíz del proyecto. */
function proyectoDe(carpeta) {
    let dir = carpeta;
    for (let i = 0; dir && i < 8; i++) {
        if (RAICES.some(f => GLib.file_test(GLib.build_filenamev([dir, f]), GLib.FileTest.EXISTS))) {
            let nombre = GLib.path_get_basename(dir);
            const paquete = leer(GLib.build_filenamev([dir, 'package.json']));
            try {
                nombre = JSON.parse(paquete ?? 'null')?.name || nombre;
            } catch {
                // package.json dañado: se queda el nombre de la carpeta
            }
            return {nombre, ruta: dir};
        }
        const padre = GLib.path_get_dirname(dir);
        if (padre === dir)
            break;
        dir = padre;
    }
    return {nombre: GLib.path_get_basename(carpeta), ruta: carpeta};
}

/** ¿Está en tus carpetas (y no dentro de una oculta como ~/.npm-global o ~/.cache)? */
function esTuyo(ruta) {
    if (!ruta.startsWith(`${HOME}/`))
        return false;
    return !ruta.slice(HOME.length + 1).split('/').some(parte => parte.startsWith('.'));
}

/**
 * Lee la salida de `ss -ltnpH` y devuelve un Map pid → puertos.
 * Línea de ejemplo: LISTEN 0 511 [::1]:5199 [::]:* users:(("node-MainThread",pid=153480,fd=22))
 */
export function puertosPorPid(salida) {
    const mapa = new Map();
    for (const linea of salida.split('\n')) {
        const columnas = linea.trim().split(/\s+/);
        if (columnas.length < 6)
            continue;
        const puerto = Number(columnas[3].slice(columnas[3].lastIndexOf(':') + 1));
        if (!Number.isInteger(puerto) || puerto < 1024)
            continue;
        for (const m of linea.matchAll(/pid=(\d+)/g)) {
            const pid = Number(m[1]);
            if (!mapa.has(pid))
                mapa.set(pid, new Set());
            mapa.get(pid).add(puerto);
        }
    }
    return mapa;
}

/** Arma la lista de servidores a partir del mapa pid → puertos. */
export function describir(mapa) {
    const servidores = [];
    for (const [pid, puertos] of mapa) {
        const ejecutable = enlace(`/proc/${pid}/exe`);
        if (!ejecutable || !EJECUTABLES.test(GLib.path_get_basename(ejecutable).replace(/ \(deleted\)$/, '')))
            continue;
        const arranque = arranqueDe(pid);
        const carpeta = enlace(`/proc/${pid}/cwd`);
        if (arranque === null || !carpeta)
            continue;
        const comando = (leer(`/proc/${pid}/cmdline`) ?? '').split('\0').join(' ').trim();
        const proyecto = proyectoDe(carpeta);
        servidores.push({
            pid,
            arranque,
            puertos: [...puertos].sort((a, b) => a - b),
            proyecto: proyecto.nombre,
            ruta: proyecto.ruta,
            tuyo: esTuyo(proyecto.ruta),
            herramienta: herramientaDe(comando) ?? GLib.path_get_basename(ejecutable),
            memoria: memoriaDe(pid),
            prendido: segundosPrendido(arranque),
        });
    }
    // Primero los de tus proyectos; dentro de cada grupo, los más viejos (los olvidados) arriba.
    return servidores.sort((a, b) => Number(b.tuyo) - Number(a.tuyo) || b.prendido - a.prendido);
}

/** Corre `ss` sin bloquear GNOME y entrega la lista de servidores (o null si falló). */
export function buscarServidores(cancelable, alTerminar) {
    let proceso;
    try {
        proceso = Gio.Subprocess.new(['ss', '-ltnpH'], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
        logError(e, 'Servidores de desarrollo: no se pudo correr ss');
        alTerminar(null);
        return;
    }
    proceso.communicate_utf8_async(null, cancelable, (p, resultado) => {
        try {
            const [, salida] = p.communicate_utf8_finish(resultado);
            alTerminar(describir(puertosPorPid(salida ?? '')));
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, 'Servidores de desarrollo: falló la búsqueda');
            alTerminar(null);
        }
    });
}

/**
 * Apaga el servidor: primero le pide que cierre (SIGTERM) y, si a los 3 s sigue vivo, lo obliga (SIGKILL).
 * Antes de cada señal revisa que el pid siga siendo el mismo proceso (Linux reutiliza los números).
 */
export function apagar(servidor, alTerminar) {
    const mismo = () => arranqueDe(servidor.pid) === servidor.arranque;
    const senal = nombre => {
        try {
            Gio.Subprocess.new(['kill', `-${nombre}`, String(servidor.pid)], Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            logError(e, 'Servidores de desarrollo: no se pudo apagar');
        }
    };
    if (!mismo()) {
        alTerminar();
        return 0;
    }
    senal('TERM');
    return GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
        if (mismo())
            senal('KILL');
        alTerminar();
        return GLib.SOURCE_REMOVE;
    });
}

export function formatoMemoria(bytes) {
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export function formatoTiempo(segundos) {
    if (segundos < 60)
        return 'hace un momento';
    if (segundos < 3600)
        return `hace ${Math.floor(segundos / 60)} min`;
    if (segundos < 86400)
        return `hace ${Math.floor(segundos / 3600)} h`;
    return `hace ${Math.floor(segundos / 86400)} d`;
}
