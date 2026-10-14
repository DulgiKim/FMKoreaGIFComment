# FMKoreaGIFComment
펨코에서 gif 댓글 달 수 있게 해주는 크롬 확장기능입니다

## 기능
- **GIF 넣기**: 댓글창 아래 `GIF` 버튼으로 Tenor GIF를 검색하고 고르면, GIF 주소가 댓글에 들어갑니다. 등록은 펨코 원래 버튼으로 합니다.
- **GIF 보기**: 댓글에 있는 Tenor 주소(`media.tenor.com/...gif`, `tenor.com/view/...`)를 GIF 이미지로 바꿔 보여줍니다.
- 즐겨찾기(★), Tenor 링크 붙여넣기를 지원합니다.

> 펨코 서버는 GIF를 지원하지 않기 때문에, GIF는 **이 확장을 설치한 사람에게만** 보입니다. 다른 사람에게는 링크로 보입니다.

## 설치
1. 이 저장소를 내려받거나 clone 합니다.
2. 크롬에서 `chrome://extensions`를 열고 **개발자 모드**를 켭니다.
3. **압축해제된 확장 프로그램을 로드합니다**를 눌러 이 폴더를 선택합니다.

## 구조
- `src/content.js`: 댓글 GIF 표시, GIF 버튼과 선택창
- `src/sw.js`: Tenor 검색/추천/링크 해석 (서비스 워커)
- `src/content.css`: 버튼과 댓글 GIF 스타일

YouTube 댓글용 확장 "Desktop GIFs"의 Tenor 연동 코드를 바탕으로 만들었습니다.
