const { parseMediaStingerSeoText } = require('../src/scrapers/mediastinger');

describe('parseMediaStingerSeoText', () => {
    it('should return all false for null or empty input', () => {
        expect(parseMediaStingerSeoText(null)).toEqual({
            seoMid: false,
            seoPost: false,
            seoBloopers: false,
            seoNo: false,
            noStinger: false,
        });
        expect(parseMediaStingerSeoText('')).toEqual({
            seoMid: false,
            seoPost: false,
            seoBloopers: false,
            seoNo: false,
            noStinger: false,
        });
    });

    it('should return seoNo and noStinger when input contains "no" but no position keywords', () => {
        expect(parseMediaStingerSeoText('no extra scenes')).toEqual({
            seoMid: false,
            seoPost: false,
            seoBloopers: false,
            seoNo: true,
            noStinger: true,
        });
    });

    it('should return seoNo and seoMid false when input contains "no" and "during" or "mid"', () => {
        expect(parseMediaStingerSeoText('no extra scenes during the credits')).toEqual({
            seoMid: 'false',
            seoPost: false,
            seoBloopers: false,
            seoNo: true,
            noStinger: false,
        });
        expect(parseMediaStingerSeoText('zero mid credits scenes')).toEqual({
            seoMid: 'false',
            seoPost: false,
            seoBloopers: false,
            seoNo: true,
            noStinger: false,
        });
    });

    it('should return seoNo and seoPost false when input contains "no" and "after" or "post"', () => {
        expect(parseMediaStingerSeoText('no extra scenes after the credits')).toEqual({
            seoMid: false,
            seoPost: 'false',
            seoBloopers: false,
            seoNo: true,
            noStinger: false,
        });
        expect(parseMediaStingerSeoText('zero post credits scenes')).toEqual({
            seoMid: false,
            seoPost: 'false',
            seoBloopers: false,
            seoNo: true,
            noStinger: false,
        });
    });

    it('should return seoMid when input contains "during" or "mid" without "no"', () => {
        expect(parseMediaStingerSeoText('there is an extra scene during the credits')).toEqual({
            seoMid: true,
            seoPost: false,
            seoBloopers: false,
            seoNo: false,
            noStinger: false,
        });
    });

    it('should return seoPost when input contains "after" or "post" without "no"', () => {
        expect(parseMediaStingerSeoText('there is an extra scene after the credits')).toEqual({
            seoMid: false,
            seoPost: true,
            seoBloopers: false,
            seoNo: false,
            noStinger: false,
        });
    });

    it('should return seoBloopers when input contains "blooper" or "outtake"', () => {
        expect(parseMediaStingerSeoText('bloopers and outtakes during the credits')).toEqual({
            seoMid: true,
            seoPost: false,
            seoBloopers: true,
            seoNo: false,
            noStinger: false,
        });
    });

    it('should handle combined scenarios correctly', () => {
        expect(parseMediaStingerSeoText('extra scene during the credits, but no extra scenes after')).toEqual({
            seoMid: 'false',
            seoPost: 'false',
            seoBloopers: false,
            seoNo: true,
            noStinger: false,
        });
    });
});
