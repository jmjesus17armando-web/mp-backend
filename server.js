// server.js
import express from 'express';
import cors from 'cors';
import { MercadoPagoConfig, Payment } from 'mercadopago';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

let oauthCredentials = { access_token: null };

// =======================================================
// CONFIGURAÇÕES DE FRETE (Correios)
// =======================================================
const STORE_ORIGIN_ZIP = "13471-140"; // 
const CORREIOS_SERVICE_PAC = "04510"; // PAC
const CORREIOS_SERVICE_SEDEX = "04014"; // SEDEX

// =======================================================
// NOVA ROTA: CALCULAR FRETE REAL
// =======================================================
app.post('/calculate_shipping', async (req, res) => {
    try {
        const { destinationZip, items } = req.body;
        
        if (!destinationZip || !items || items.length === 0) {
            return res.status(400).json({ error: "CEP de destino ou itens ausentes." });
        }

        const sCepDestino = destinationZip.replace(/\D/g, '');
        
        let totalWeight = 0;
        let maxLength = 0;
        let maxWidth = 0;
        let maxHeight = 0;
        let declaredValue = 0;

        items.forEach(item => {
            // Converte peso para número (ex: "5,0 KG" vira 5.0)
            const weightStr = String(item.peso).replace(/[^\d,\.]/g, '').replace(',', '.');
            totalWeight += parseFloat(weightStr) * item.qty;
            
            // Extrai números do tamanho (ex: "62X60X23 CM" vira [62, 60, 23])
            const dimensions = String(item.tamanho).match(/\d+/g);
            if (dimensions && dimensions.length >= 3) {
                maxLength = Math.max(maxLength, parseInt(dimensions[0]));
                maxWidth = Math.max(maxWidth, parseInt(dimensions[1]));
                maxHeight = Math.max(maxHeight, parseInt(dimensions[2]));
            }
            
            declaredValue += item.price * item.qty;
        });

        // Correios exige peso mínimo de 0.3kg
        if (totalWeight < 0.3) totalWeight = 0.3;
        if (totalWeight > 30) totalWeight = 30;

        // Limites mínimos dos Correios
        if (maxLength < 16) maxLength = 16;
        if (maxWidth < 11) maxWidth = 11;
        if (maxHeight < 2) maxHeight = 2;

        const correiosParams = new URLSearchParams({
            nCdEmpresa: '',
            sDsSenha: '',
            nCdServico: `${CORREIOS_SERVICE_PAC},${CORREIOS_SERVICE_SEDEX}`,
            sCepOrigem: STORE_ORIGIN_ZIP,
            sCepDestino: sCepDestino,
            nVlPeso: totalWeight.toFixed(1).replace('.', ','),
            nCdFormato: '1',
            nVlComprimento: maxLength,
            nVlAltura: maxHeight,
            nVlLargura: maxWidth,
            nVlDiametro: 0,
            sCdMaoPropria: 'n',
            nVlValorDeclarado: declaredValue > 25 ? declaredValue.toFixed(2).replace('.', ',') : '0,00',
            sCdAvisoRecebimento: 'n',
            StrRetorno: 'xml'
        });

        const correiosURL = `http://ws.correios.com.br/calculador/CalcPrecoPrazo.aspx?${correiosParams.toString()}`;
        
        // Usando fetch nativo do Node (disponível no Railway)
        const response = await fetch(correiosURL);
        const xmlData = await response.text();
        
        const parseCorreiosResponse = (xml, serviceCode) => {
            // Regex para extrair preço, prazo e erro do XML dos Correios
            const regex = new RegExp(`<cServico>[\\s\\S]*?<Codigo>${serviceCode}<\\/Codigo>[\\s\\S]*?<Valor>(.*?)<\\/Valor>[\\s\\S]*?<PrazoEntrega>(.*?)<\\/PrazoEntrega>[\\s\\S]*?<Erro>(.*?)<\\/Erro>[\\s\\S]*?<MsgErro>(.*?)<\\/MsgErro>[\\s\\S]*?<\\/cServico>`, 's');
            const match = xml.match(regex);
            if (match) {
                return {
                    code: serviceCode,
                    price: match[1],
                    days: match[2],
                    error: match[3] !== '0' ? match[4] : null
                };
            }
            return null;
        };

        const pac = parseCorreiosResponse(xmlData, CORREIOS_SERVICE_PAC);
        const sedex = parseCorreiosResponse(xmlData, CORREIOS_SERVICE_SEDEX);

        const shippingOptions = [];
        if (pac && !pac.error) shippingOptions.push({ type: 'PAC', ...pac });
        if (sedex && !sedex.error) shippingOptions.push({ type: 'SEDEX', ...sedex });

        if (shippingOptions.length === 0) {
            return res.status(400).json({ error: "Não foi possível calcular o frete para esta região." });
        }

        res.json({ options: shippingOptions });

    } catch (error) {
        console.error('Erro ao calcular frete:', error);
        res.status(500).json({ error: "Erro interno ao consultar transportadora." });
    }
});

// =======================================================
// ROTAS ORIGINAIS (OAuth e Pagamento)
// =======================================================

// Rota OAuth 
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Código não fornecido' });
  try {
    const response = await fetch('https://api.mercadopago.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.MP_CLIENT_ID,
        client_secret: process.env.MP_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: `${process.env.BACKEND_URL}/oauth/callback`
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error_description);
    oauthCredentials.access_token = data.access_token;
    res.send('<h1>✅ OAuth concluído! Feche esta janela.</h1><script>window.close()</script>');
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ROTA PRINCIPAL - PROCESSAR PAGAMENTO 
app.post('/process_payment', async (req, res) => {
  try {
    let accessToken = oauthCredentials.access_token || process.env.MP_ACCESS_TOKEN;
    if (!accessToken) {
      return res.status(500).json({ error: 'Token de acesso não configurado' });
    }

    const { transaction_amount, description, payment_method_id, payer } = req.body;

    if (payment_method_id === 'pix' && (!payer || !payer.email)) {
      return res.status(400).json({ error: 'E-mail do comprador é obrigatório para PIX' });
    }

    const client = new MercadoPagoConfig({ accessToken });
    const payment = new Payment(client);

    const paymentData = {
      transaction_amount: Number(transaction_amount),
      description: description || 'Pedido Marketplace Aliança',
      payment_method_id: payment_method_id,
      payer: {
        email: payer.email,
        first_name: payer.first_name || '',
        last_name: payer.last_name || '',
        identification: payer.identification || { type: 'CPF', number: '' },
        phone: payer.phone || { area_code: '', number: '' },
        address: payer.address || {}
      }
    };

    if (req.body.token && (payment_method_id === 'credit_card' || payment_method_id === 'debit_card')) {
      paymentData.token = req.body.token;
      if (req.body.installments) paymentData.installments = req.body.installments;
    }

    console.log('📤 Enviando para MP:', JSON.stringify(paymentData, null, 2));

    const response = await payment.create({ body: paymentData });
    console.log('✅ Resposta do MP:', JSON.stringify(response, null, 2));

    const result = {
      id: response.id,
      status: response.status,
      status_detail: response.status_detail,
      order_number: '#' + String(response.id).slice(-6),
      transaction_amount: response.transaction_amount
    };

    if (response.point_of_interaction) {
      result.point_of_interaction = response.point_of_interaction;
    }
    if (response.transaction_details) {
      result.transaction_details = response.transaction_details;
    }

    res.status(201).json(result);
  } catch (error) {
    console.error('❌ Erro no backend:', error);
    res.status(500).json({ error: error.message, details: error.cause?.body });
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));