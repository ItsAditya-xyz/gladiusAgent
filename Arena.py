import requests 
from dotenv import load_dotenv
import os
load_dotenv()
import json 
from logging_utils import get_logger

logger = get_logger(__name__)

PARTNER_KEY = os.getenv("PARTNER_KEY")
JWT = os.getenv("JWT")


def get_latest_post():
    url = "https://api.starsarena.com/partners/recent-threads?offset=0"
    headers = {
        "Authorization": f'Bearer {PARTNER_KEY}'
    }
    response = requests.get(url, headers=headers).json()
    return response


def token_community_search(name_query: str):
    url = f"https://api.starsarena.com/communities/search?searchString={name_query}"
    logger.info("token community search | url=%s", url)
    headers = {
        "Authorization": f'Bearer {JWT}'
    }
    response = requests.get(url, headers=headers).json()

    return response


def get_followers_by_user_id(user_id: str):
    url = f'https://api.starsarena.com/follow/followers/list?followersOfUserId={user_id}&searchString=&pageNumber=1&pageSize={50}'
    headers = {
        "Authorization": f'Bearer {JWT}'
    }
    response = requests.get(url, headers=headers).json()
    return response
