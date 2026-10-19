const nodemailer = require("nodemailer");

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
});

const send = async (to, subject, text) => {
  try {
    await transport.sendMail({
      from: process.env.MAIL_FROM,
      to,
      subject,
      text,
    });
  } catch (err) {
    console.error("email send failed", subject, err.message);
  }
};

exports.sendVerification = (to, token) =>
  send(
    to,
    "Verify your RELAY email",
    `Verify your email: ${process.env.APP_BASE_URL}/verify?token=${token}`,
  );

exports.sendPasswordReset = (to, token) =>
  send(
    to,
    "Reset your RELAY password",
    `Reset your password: ${process.env.APP_BASE_URL}/reset-password?token=${token}`,
  );

exports.sendSignupAttempt = (to) =>
  send(
    to,
    "Sign-up attempt on your RELAY account",
    "Someone tried to sign up with this email address. If it was you, log in or reset your password instead. Otherwise ignore this message.",
  );
