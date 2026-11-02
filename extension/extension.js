// Servidores de desarrollo: muestra en la barra de GNOME los servidores (vite, next…) que siguen prendidos,
// con su puerto, proyecto y memoria, y botones para abrirlos en Brave o apagarlos.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {apagar, buscarServidores, formatoMemoria, formatoTiempo} from './servidores.js';

const REVISAR_CADA = 10; // segundos
const OLVIDADO_DESDE = 3 * 3600; // s: a partir de aquí el "prendido hace…" sale en amarillo
const NAVEGADOR = 'brave-browser.desktop';

function etiqueta(texto, clase = null, params = {}) {
    const l = new St.Label({text: texto, y_align: Clutter.ActorAlign.CENTER, ...params});
    if (clase)
        l.style_class = clase;
    return l;
}

function filaFija() {
    return new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
}

function boton(icono, nombre, clase, alPulsar) {
    const b = new St.Button({
        style_class: `sd-boton ${clase}`,
        child: new St.Icon({icon_name: icono, style_class: 'popup-menu-icon'}),
        accessible_name: nombre,
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    b.connect('clicked', alPulsar);
    return b;
}

function abrirEnNavegador(url) {
    const app = Gio.DesktopAppInfo.new(NAVEGADOR);
    try {
        if (app)
            app.launch_uris([url], global.create_app_launch_context(0, -1));
        else
            Gio.AppInfo.launch_default_for_uri(url, null); // sin Brave: el navegador por defecto
    } catch (e) {
        logError(e, `Servidores de desarrollo: no se pudo abrir ${url}`);
    }
}

const Indicador = GObject.registerClass(
class Indicador extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Servidores de desarrollo');
        this._servidores = [];
        this._apagando = new Set(); // pids a los que ya se les mandó apagar
        this._temporizadores = new Set();
        this._cancelable = new Gio.Cancellable();
        this._buscando = false;

        const caja = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        caja.add_child(new St.Icon({icon_name: 'network-server-symbolic', style_class: 'system-status-icon'}));
        this._cuenta = etiqueta('0', 'sd-cuenta');
        caja.add_child(this._cuenta);
        this.add_child(caja);
        this.visible = false; // sin servidores prendidos no ocupa lugar en la barra

        this._encabezado = new PopupMenu.PopupMenuSection();
        this._lista = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._encabezado);
        this.menu.addMenuItem(this._lista);
        this.menu.connect('open-state-changed', (_m, abierto) => {
            if (abierto)
                this._buscar();
        });

        this._temporizador = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REVISAR_CADA, () => {
            this._buscar();
            return GLib.SOURCE_CONTINUE;
        });
        this._buscar();
    }

    _buscar() {
        if (this._buscando)
            return;
        this._buscando = true;
        buscarServidores(this._cancelable, lista => {
            this._buscando = false;
            if (lista === null || this._cancelable.is_cancelled())
                return; // falló o la extensión se apagó: se deja lo último que se vio
            const vivos = new Set(lista.map(s => s.pid));
            for (const pid of this._apagando) {
                if (!vivos.has(pid))
                    this._apagando.delete(pid);
            }
            this._servidores = lista;
            this._pintar();
        });
    }

    _pintar() {
        const n = this._servidores.length;
        this.visible = n > 0;
        this._cuenta.text = String(n);
        if (n === 0 && this.menu.isOpen)
            this.menu.close();

        this._encabezado.removeAll();
        const total = this._servidores.reduce((suma, s) => suma + s.memoria, 0);
        const fila = filaFija();
        fila.add_child(etiqueta(n === 1 ? '1 servidor prendido' : `${n} servidores prendidos`, 'sd-titulo', {x_expand: true}));
        fila.add_child(etiqueta(formatoMemoria(total), 'sd-titulo'));
        this._encabezado.addMenuItem(fila);

        this._lista.removeAll();
        const tuyos = this._servidores.filter(s => s.tuyo);
        const otros = this._servidores.filter(s => !s.tuyo);
        if (tuyos.length)
            this._seccion('Tus proyectos', tuyos);
        if (otros.length)
            this._seccion('Otros programas', otros);
    }

    _seccion(titulo, servidores) {
        const fila = filaFija();
        const caja = new St.BoxLayout({x_expand: true});
        caja.add_child(etiqueta(titulo, 'sd-seccion'));
        caja.add_child(new St.Widget({style_class: 'sd-linea', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        fila.add_child(caja);
        this._lista.addMenuItem(fila);
        for (const s of servidores)
            this._lista.addMenuItem(this._filaServidor(s));
    }

    _filaServidor(s) {
        const fila = filaFija();
        const apagando = this._apagando.has(s.pid);

        const columna = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const arriba = new St.BoxLayout({x_expand: true});
        arriba.add_child(etiqueta(s.proyecto, 'sd-proyecto', {x_expand: true}));
        arriba.add_child(etiqueta(s.puertos.map(p => `:${p}`).join(' '), 'sd-puerto'));
        columna.add_child(arriba);

        const abajo = new St.BoxLayout();
        abajo.add_child(etiqueta(`${s.herramienta} · ${formatoMemoria(s.memoria)} · `, 'sd-detalle'));
        abajo.add_child(etiqueta(apagando ? 'apagando…' : `prendido ${formatoTiempo(s.prendido)}`,
            s.prendido >= OLVIDADO_DESDE && !apagando ? 'sd-detalle sd-olvidado' : 'sd-detalle'));
        columna.add_child(abajo);
        fila.add_child(columna);

        const botones = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        const url = `http://localhost:${s.puertos[0]}`;
        botones.add_child(boton('web-browser-symbolic', `Abrir ${s.proyecto} en el navegador`, 'sd-abrir', () => {
            this.menu.close();
            abrirEnNavegador(url);
        }));
        const apagarBoton = boton('system-shutdown-symbolic', `Apagar el servidor de ${s.proyecto}`, 'sd-apagar', () => {
            if (this._apagando.has(s.pid))
                return;
            this._apagando.add(s.pid);
            this._pintar();
            const id = apagar(s, () => {
                this._temporizadores.delete(id);
                this._buscar();
            });
            if (id)
                this._temporizadores.add(id);
        });
        apagarBoton.reactive = !apagando;
        botones.add_child(apagarBoton);
        fila.add_child(botones);
        return fila;
    }

    destroy() {
        this._cancelable.cancel();
        if (this._temporizador)
            GLib.source_remove(this._temporizador);
        this._temporizador = 0;
        for (const id of this._temporizadores)
            GLib.source_remove(id);
        this._temporizadores.clear();
        super.destroy();
    }
});

export default class ServidoresDev extends Extension {
    enable() {
        this._indicador = new Indicador();
        // A la izquierda, al final: queda junto al nombre de la app abierta.
        Main.panel.addToStatusArea(this.uuid, this._indicador, -1, 'left');
    }

    disable() {
        this._indicador?.destroy();
        this._indicador = null;
    }
}
