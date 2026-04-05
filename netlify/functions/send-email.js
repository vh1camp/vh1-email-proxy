exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "ok" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: "Method not allowed" };
  }

  try {
    const { to, from, subject, html } = JSON.parse(event.body);

    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.SENDGRID_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from, name: "VH1 Basketball Officials Camp" },
        subject: subject,
        content: [{ type: "text/html", value: html }],
      }),
    });

    if (response.ok || response.status === 202) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    } else {
      const err = await response.text();
      return { statusCode: 500, headers, body: JSON.stringify({ error: err }) };
    }
  } catch (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
