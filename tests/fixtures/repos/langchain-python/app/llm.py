import os
from langchain_openai import ChatOpenAI
from langchain_anthropic import ChatAnthropic

def get_chat_model(provider: str):
    if provider == "openai":
        return ChatOpenAI(model="gpt-4o", api_key=os.environ["OPENAI_API_KEY"])
    if provider == "anthropic":
        return ChatAnthropic(model="claude-3-5-sonnet-20241022")
    raise ValueError(f"unknown provider: {provider}")
