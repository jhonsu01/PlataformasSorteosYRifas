// Envio de correo por Gmail (SMTP, contrasena de aplicacion).
//
// Se usa para entregarle al VENDEDOR sus datos de ingreso apenas el admin crea la
// cuenta. Es de "mejor esfuerzo": si el envio falla o Gmail no esta configurado,
// el vendedor ya quedo creado y el admin puede pasarle los datos a mano. Por eso
// sendSellerWelcome nunca lanza: devuelve { sent, error } y el endpoint decide.
//
// nodemailer se importa de forma perezosa (dynamic import) para no pagar su carga
// en cada arranque en frio de la funcion serverless si nadie manda correos.

import { config, isEmailConfigured } from "./config.js";

let transporterPromise = null;

async function getTransporter() {
  if (!isEmailConfigured()) return null;
  if (!transporterPromise) {
    transporterPromise = import("nodemailer").then((mod) => {
      const nodemailer = mod.default || mod;
      return nodemailer.createTransport({
        service: "gmail",
        auth: { user: config.email.gmailUser, pass: config.email.gmailAppPassword },
      });
    });
  }
  return transporterPromise;
}

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/**
 * Manda al vendedor su correo de bienvenida con: datos de ingreso, link de
 * descarga de la app y los pasos a seguir. Nunca lanza.
 *
 * @returns {{ sent: boolean, error?: string }}
 */
export async function sendSellerWelcome({ fullName, email, password, raffles = [] }) {
  const transporter = await getTransporter();
  if (!transporter) return { sent: false, error: "Correo no configurado (GMAIL_USER/GMAIL_APP_PASSWORD)" };

  const nombre = fullName || email;
  const descarga = config.downloadBase;
  const listaRifas = raffles.length
    ? raffles.map((r) => `• ${r}`).join("\n")
    : "(el administrador te asignara rifas en breve)";

  const texto = [
    `Hola ${nombre},`,
    ``,
    `Se creo tu cuenta de VENDEDOR en Sorteos y Rifas. Con ella puedes ver las`,
    `rifas que te asignaron y verificar (aprobar) los pagos manuales de esas rifas.`,
    ``,
    `DATOS DE INGRESO`,
    `  Correo:      ${email}`,
    `  Contrasena:  ${password}`,
    ``,
    `RIFAS ASIGNADAS`,
    listaRifas,
    ``,
    `PASOS PARA EMPEZAR`,
    `  1. Descarga la app de vendedor (APK Android) desde:`,
    `     ${descarga}`,
    `     Busca el archivo "SorteosRifas-Vendedor-....apk" e instalalo`,
    `     (permite instalar de origenes desconocidos si te lo pide).`,
    `  2. Abre la app e inicia sesion con el correo y la contrasena de arriba.`,
    `  3. (Recomendado) Activa la verificacion en dos pasos (2FA) desde la app`,
    `     para proteger tu cuenta.`,
    `  4. Cambia esta contrasena por una tuya si la app te lo permite.`,
    ``,
    `Si no reconoces este correo, ignoralo.`,
  ].join("\n");

  const html = `
  <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;color:#1c1330">
    <h2 style="color:#6d28d9">Bienvenido a Sorteos y Rifas</h2>
    <p>Hola <strong>${esc(nombre)}</strong>, se creo tu cuenta de <strong>vendedor</strong>.
    Con ella puedes ver tus rifas asignadas y verificar los pagos manuales de esas rifas.</p>
    <h3 style="margin-bottom:4px">Datos de ingreso</h3>
    <table style="border-collapse:collapse">
      <tr><td style="padding:2px 10px 2px 0">Correo:</td><td><strong>${esc(email)}</strong></td></tr>
      <tr><td style="padding:2px 10px 2px 0">Contrase&ntilde;a:</td><td><strong>${esc(password)}</strong></td></tr>
    </table>
    <h3 style="margin-bottom:4px">Rifas asignadas</h3>
    <p>${raffles.length ? raffles.map((r) => `&bull; ${esc(r)}`).join("<br>") : "<em>El administrador te asignar&aacute; rifas en breve.</em>"}</p>
    <h3 style="margin-bottom:4px">Pasos para empezar</h3>
    <ol>
      <li>Descarga la app de vendedor (APK Android) desde
        <a href="${esc(descarga)}">${esc(descarga)}</a> (archivo
        <em>SorteosRifas-Vendedor-....apk</em>).</li>
      <li>Abre la app e inicia sesi&oacute;n con el correo y la contrase&ntilde;a de arriba.</li>
      <li>Recomendado: activa la verificaci&oacute;n en dos pasos (2FA) desde la app.</li>
      <li>Cambia esta contrase&ntilde;a por una tuya si la app te lo permite.</li>
    </ol>
    <p style="color:#6b6580;font-size:13px">Si no reconoces este correo, ign&oacute;ralo.</p>
  </div>`;

  try {
    await transporter.sendMail({
      from: config.email.from || config.email.gmailUser,
      to: email,
      subject: "Tu cuenta de vendedor — Sorteos y Rifas",
      text: texto,
      html,
    });
    return { sent: true };
  } catch (e) {
    return { sent: false, error: String(e?.message || e) };
  }
}
