export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
  }>;
}

export class AIProvider {
  
  public baseUrl:string;
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly modelName: string;

  constructor() {
    this.baseUrl =process.env.BASE_URL ?? 'https://www.etihad.com/en-in/';
    this.apiUrl =process.env.API_URL ?? '';
    this.apiKey =process.env.API_KEY ?? '';
    this.modelName =process.env.MODEL_NAME ?? '';
    this.validateConfiguration();
  }

  private validateConfiguration(): void {
    if (!this.apiUrl) {throw new Error('API_URL is not configured');}
    if (!this.apiKey) {throw new Error('API_KEY is not configured');}
    if (!this.modelName) {throw new Error('MODEL_NAME is not configured');}
  }

  async chat(
    messages: ChatMessage[]
  ): Promise<string> {

    const response = await fetch(
      this.apiUrl,
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': this.apiKey
        },

        body: JSON.stringify({
          model: this.modelName,
          messages,
          temperature: 0.2,
          top_p: 0.9,
          max_tokens: 12000
        })
      }
    );

    if (!response.ok) {

      const errorBody =await response.text();

      throw new Error(
        `Coforge AI request failed.
Status: ${response.status}
Response: ${errorBody}`
      );
    }

    const data =await response.json() as ChatResponse;
    const content =data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('Coforge AI response does not contain message content.');
    }

    return content.trim();
  }
}