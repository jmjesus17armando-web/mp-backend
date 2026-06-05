// server.js
import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Payment } from 'mercadopago';

const app = express();
const PORT = process.env.PORT || 3000;

// Configurações essenciais
app.use(express.json());
app.use(cors());

// ========================
// VARIÁVEIS EM MEMÓRIA PARA ARMAZENAR CREDENCIAIS OAuth
// ========================
let oauthCredentials = {
  access_token: null,
  public_key: null,
  refresh_token: null,
  expires_in: null,
  user_id: null
};

// ========================
// ROTA 1: OAuth Callback (recebe o code e troca por token)
// ========================
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'Código de autorização não fornecido' });
  }

  try {
    // Trocar o code por tokens no Mercado Pago
    const response = await fetch('https://api.mercadopago.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        client_id: process.env.MP_CLIENT_ID,
        client_secret: process.env.MP_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: `${process.env.BACKEND_URL || 'https://mp-backend-production-0e4a.up.railway.app'}/oauth/callback`
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Erro na troca do code:', data);
      return res.status(response.status).json({ error: data.error_description || 'Falha na autenticação' });
    }

    // Salvar credenciais em memória
    oauthCredentials = {
      access_token: data.access_token,
      public_key: data.public_key,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      user_id: data.user_id
    };

    console.log('Credenciais OAuth armazenadas com sucesso!');
    
    // Redireciona para uma página de sucesso ou exibe JSON
    res.send(`
      <h1>✅ Integração concluída!</h1>
      <p>As credenciais do seu cliente foram salvas. Agora você pode fechar esta janela.</p>
      <script>setTimeout(() => window.close(), 3000);</script>
    `);
  } catch (error) {
    console.error('Erro no callback OAuth:', error);
    res.status(500).json({ error: 'Erro interno ao processar autorização' });
  }
});

// ========================
// ROTA 2: Obter credenciais salvas
// ========================
app.get('/oauth/credentials', (req, res) => {
  if (!oauthCredentials.access_token) {
    return res.status(404).json({ error: 'Nenhuma credencial OAuth encontrada. Faça a autorização primeiro.' });
  }
  
  res.json({
    access_token: oauthCredentials.access_token,
    public_key: oauthCredentials.public_key,
    expires_in: oauthCredentials.expires_in,
    user_id: oauthCredentials.user_id
  });
});

// ========================
// ROTA EXISTENTE: Processar pagamento
// ========================
app.post('/process_payment', async (req, res) => {
  try {
    // Se existir credencial OAuth, usa ela; senão, usa a variável ambiente (sua conta)
    const accessToken = oauthCredentials.access_token || process.env.MP_ACCESS_TOKEN;
    
    if (!accessToken) {
      return res.status(500).json({ error: 'Nenhum token de acesso configurado' });
    }

    const client = new MercadoPagoConfig({ accessToken });
    const payment = new Payment(client);

    const { token, transaction_amount, description, payment_method_id, payer } = req.body;

    const paymentData = {
      transaction_amount: transaction_amount,
      description: description,
      payment_method_id: payment_method_id,
      payer: payer,
      token: token,
      installments: 1,
    };

    const response = await payment.create({ body: paymentData });
    console.log('Resposta do Mercado Pago:', response);
    res.status(201).json(response);
  } catch (error) {
    console.error('Erro ao processar pagamento:', error);
    res.status(500).json({ error: error.message });
  }
});

// Inicia o servidor
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));